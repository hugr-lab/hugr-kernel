/**
 * Search section — `_search` over hugr's LOGICAL model.
 *
 * One box that ranks modules, data sources, data objects, functions and fields
 * by relevance: semantic where the deployment has a vector index, substring
 * matching where it does not — and the note line says which. Hits are grouped
 * by entity kind and each opens its catalog detail view.
 *
 * The kind select narrows server-side (`kinds:`), the match select picks the
 * track: NAME is the only way to find an identifier (names never enter the
 * vector index, which embeds descriptions), MEANING ranks over descriptions,
 * BOTH concatenates name matches first. The limit stays small on purpose —
 * the engine verifies limit×overfetch candidates per search, so the limit is
 * the knob that decides how long a search takes on a 200k-object model.
 *
 * Nothing is probed or fetched until the tab is actually shown.
 *
 * Ported to VS Code as searchViewProvider.ts — keep the two in step.
 */
import { HugrClient } from '../hugrClient';
import { kindIcon, hugrTypeIcon } from './icons';
import type { CatalogOpenTarget } from './catalogTree';

type SearchMatch = 'NAME' | 'MEANING' | 'BOTH';

const SEARCH_QUERY = `query($q: String!, $m: _SearchMatch!, $k: [_SearchKind!]) {
  _search(query: $q, match: $m, kinds: $k, limit: 20) {
    lexical
    lexicalReason
    hasMore
    filteredOut
    items {
      kind matchedOn name moduleName dataSourceName description score
      objectName type refObjectName
      dataObject { type }
    }
  }
}`;

interface SearchHit {
  kind: string;
  matchedOn: SearchMatch;
  name: string;
  moduleName: string;
  dataSourceName?: string;
  description?: string;
  score: number;
  objectName?: string;
  type?: string;
  refObjectName?: string;
  /** DATA_OBJECT hits: the drill-down that says table-from-view. */
  dataObject?: { type?: string };
}

const GROUP_ORDER: Array<[string, string]> = [
  ['DATA_OBJECT', 'Data objects'],
  ['FUNCTION', 'Functions'],
  ['MODULE', 'Modules'],
  ['DATA_SOURCE', 'Data sources'],
  ['FIELD', 'Fields'],
];

export class SearchSection {
  private _container: HTMLElement;
  private _onShowDetail: (target: CatalogOpenTarget) => void;
  private _client: HugrClient | null = null;

  private _query = '';
  private _match: SearchMatch = 'BOTH';
  private _kind = '';
  /** Null until probed for this connection; false on an engine without _search. */
  private _available: boolean | null = null;
  private _hits: SearchHit[] | null = null;
  private _note = '';
  private _error: string | null = null;
  private _searching = false;
  private _searchVersion = 0;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _searchInput: HTMLInputElement | null = null;
  private _kindSelect: HTMLSelectElement | null = null;
  /** Everything below the controls; the only part a keystroke redraws. */
  private _body: HTMLElement | null = null;

  constructor(container: HTMLElement, onShowDetail: (target: CatalogOpenTarget) => void) {
    this._container = container;
    this._onShowDetail = onShowDetail;
    this._render();
  }

  setClient(client: HugrClient | null): void {
    this._client = client;
    this._query = '';
    this._available = null;
    this._hits = null;
    this._note = '';
    this._error = null;
    this._searchVersion++;
    this._render();
  }

  /** Cross-references land here: put the name in the box and run it. */
  setSearchQuery(query: string): void {
    this._query = query;
    // A stale kind restriction would silently exclude what the caller is
    // pointing at — a cross-reference always searches all kinds.
    this._kind = '';
    if (this._searchInput) {
      this._searchInput.value = query;
    }
    if (this._kindSelect) {
      this._kindSelect.value = '';
    }
    void this._runSearch();
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /**
   * Rebuild the whole section: the controls, then the body. Called when the
   * CONNECTION changes, never on a keystroke — the input is a live DOM node
   * the user is typing into, and re-creating it mid-word moves the caret.
   */
  private _render(): void {
    this._container.innerHTML = '';
    this._body = null;

    if (!this._client) {
      this._container.appendChild(this._status('No connection selected'));
      return;
    }

    this._container.appendChild(this._controls());

    const body = document.createElement('div');
    this._body = body;
    this._container.appendChild(body);
    this._renderBody();
  }

  private _controls(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:4px;display:flex;flex-direction:column;gap:4px;';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Describe the data in your own words…';
    input.value = this._query;
    input.style.cssText = 'width:100%;box-sizing:border-box;';
    input.addEventListener('input', () => {
      this._query = input.value;
      if (this._query.trim() === '') {
        this._hits = null;
        this._note = '';
        this._error = null;
        this._renderBody();
        return;
      }
      this._debouncedSearch();
    });
    this._searchInput = input;
    wrap.appendChild(input);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:4px;';

    const mode = document.createElement('select');
    mode.title =
      'What to match on. A name never enters the vector index — that is built ' +
      'from descriptions — so an identifier is only findable by name.';
    mode.style.cssText = 'flex:1;min-width:0;';
    for (const [value, label] of [
      ['BOTH', 'name + meaning'],
      ['NAME', 'name'],
      ['MEANING', 'meaning'],
    ] as Array<[SearchMatch, string]>) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      opt.selected = value === this._match;
      mode.appendChild(opt);
    }
    mode.addEventListener('change', () => {
      this._match = mode.value as SearchMatch;
      if (this._query.trim()) {
        void this._runSearch();
      }
    });
    row.appendChild(mode);

    const kind = document.createElement('select');
    kind.title = 'Restrict to one entity kind';
    kind.style.cssText = 'flex:1;min-width:0;';
    for (const [value, label] of [
      ['', 'all kinds'],
      ['DATA_OBJECT', 'data objects'],
      ['FUNCTION', 'functions'],
      ['MODULE', 'modules'],
      ['DATA_SOURCE', 'data sources'],
      ['FIELD', 'fields'],
    ] as Array<[string, string]>) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      opt.selected = value === this._kind;
      kind.appendChild(opt);
    }
    kind.addEventListener('change', () => {
      this._kind = kind.value;
      if (this._query.trim()) {
        void this._runSearch();
      }
    });
    this._kindSelect = kind;
    row.appendChild(kind);

    wrap.appendChild(row);
    return wrap;
  }

  private _renderBody(): void {
    const body = this._body;
    if (!body) {
      return;
    }
    body.innerHTML = '';

    if (this._error) {
      const err = this._status(this._error);
      err.style.color = 'var(--jp-error-color1, #d32f2f)';
      body.appendChild(err);
      return;
    }
    if (!this._query.trim()) {
      body.appendChild(this._status('Describe the data you are looking for'));
      return;
    }
    if (this._hits === null) {
      // Typed, but the debounce has not fired yet — or the first search is
      // still in flight. Nothing has been ANSWERED, and saying "nothing
      // matches" here would be a lie the user acts on.
      body.appendChild(this._status('Searching…'));
      return;
    }
    if (this._note) {
      const note = this._status(this._note);
      note.style.fontStyle = 'italic';
      body.appendChild(note);
    }

    // _search covers the LOGICAL model only. A generated type name (a
    // filter, an aggregation — the names error messages cite) is not in it,
    // but any exact name still opens through __type — offer that whenever
    // the query looks like one identifier.
    const lookupName = this._query.trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(lookupName)) {
      const lookup = document.createElement('div');
      lookup.style.cssText =
        'padding:4px 6px;margin-bottom:4px;cursor:pointer;border-radius:3px;' +
        'color:var(--jp-brand-color1, #1d4ed8);font-size:11px;';
      lookup.innerHTML = `Open <strong>${lookupName.replace(/</g, '&lt;')}</strong> as GraphQL type ↗`;
      lookup.addEventListener('click', () =>
        this._onShowDetail({ view: 'type', name: lookupName })
      );
      body.appendChild(lookup);
    }

    if (this._hits.length === 0 && !this._searching) {
      body.appendChild(this._status('Nothing matches'));
      return;
    }

    // One flat list reads fine when everything in it is the same thing; a
    // mixed one buries the three tables the user wanted under a page of field
    // hits. Group by entity kind — objects first, fields last — when kinds mix.
    const groups = this._groupHits(this._hits);
    for (const [label, groupHits] of groups) {
      if (groups.length > 1) {
        const header = document.createElement('div');
        header.textContent = `${label} (${groupHits.length})`;
        header.style.cssText =
          'padding:6px 6px 2px;font-size:10px;font-weight:600;text-transform:uppercase;' +
          'letter-spacing:0.05em;color:var(--jp-ui-font-color2, #888);';
        body.appendChild(header);
      }
      for (const hit of groupHits) {
        body.appendChild(this._hitRow(hit));
      }
    }
  }

  private _groupHits(hits: SearchHit[]): Array<[string, SearchHit[]]> {
    const byKind = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const bucket = byKind.get(h.kind);
      if (bucket) {
        bucket.push(h);
      } else {
        byKind.set(h.kind, [h]);
      }
    }
    const known = new Set(GROUP_ORDER.map(([k]) => k));
    const groups: Array<[string, SearchHit[]]> = [];
    for (const [k, label] of GROUP_ORDER) {
      const g = byKind.get(k);
      if (g?.length) {
        groups.push([label, g]);
      }
    }
    for (const [k, g] of byKind) {
      if (!known.has(k) && g.length) {
        groups.push([k, g]);
      }
    }
    return groups;
  }

  private _hitRow(hit: SearchHit): HTMLElement {
    const row = document.createElement('div');
    row.className = 'hugr-schema-tree-row';
    row.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:3px 6px;font-size:12px;white-space:nowrap;';

    const icon = document.createElement('span');
    icon.style.cssText = 'flex:none;display:inline-flex;';
    icon.innerHTML = this._hitIcon(hit);
    row.appendChild(icon);

    const open = this._hitOpen(hit);
    const label = document.createElement('span');
    label.textContent =
      hit.kind === 'FIELD' ? `${hit.objectName}.${hit.name}` : hit.name;
    label.style.cssText = 'font-weight:500;';
    if (open) {
      label.style.cursor = 'pointer';
      label.addEventListener('click', () => this._onShowDetail(open));
    }
    row.appendChild(label);

    // Which track found it. Worth showing: an exact name and an embedding
    // distance are not on one scale, so a NAME hit and a MEANING hit are
    // answers to different questions.
    if (hit.matchedOn === 'NAME') {
      const badge = document.createElement('span');
      badge.textContent = 'name';
      badge.style.cssText =
        'flex:none;font-size:10px;padding:0 4px;border-radius:3px;' +
        'background:var(--jp-brand-color3, #dbeafe);color:var(--jp-brand-color1, #1d4ed8);';
      row.appendChild(badge);
    }

    const meta = document.createElement('span');
    const bits = [
      hit.kind === 'FIELD' ? hit.type : '',
      hit.moduleName ? `in ${hit.moduleName}` : '',
      hit.refObjectName ? `→ ${hit.refObjectName}` : '',
    ].filter(Boolean);
    meta.textContent = bits.join('  ');
    meta.style.cssText = 'color:var(--jp-ui-font-color2, #888);font-size:11px;';
    row.appendChild(meta);

    if (hit.description) {
      const desc = document.createElement('span');
      desc.textContent = hit.description;
      desc.title = hit.description;
      desc.style.cssText =
        'color:var(--jp-ui-font-color2, #888);font-size:11px;' +
        'overflow:hidden;text-overflow:ellipsis;';
      row.appendChild(desc);
    }

    return row;
  }

  private _hitIcon(hit: SearchHit): string {
    switch (hit.kind) {
      case 'MODULE':
        return hugrTypeIcon('module');
      case 'DATA_OBJECT': {
        // Table-vs-view comes from the dataObject drill-down, which the
        // engine has already resolved for the permission check.
        const t = hit.dataObject?.type?.toLowerCase();
        return t ? hugrTypeIcon(t) : kindIcon('OBJECT');
      }
      case 'FUNCTION':
        return hugrTypeIcon('function');
      case 'DATA_SOURCE':
        return kindIcon('OBJECT');
      default:
        return kindIcon('SCALAR');
    }
  }

  /** Where a hit navigates: every hit kind has a catalog detail view. */
  private _hitOpen(hit: SearchHit): CatalogOpenTarget | null {
    switch (hit.kind) {
      case 'DATA_OBJECT':
        return { view: 'dataObject', name: hit.name };
      case 'FUNCTION':
        return { view: 'function', name: hit.name, module: hit.moduleName ?? '' };
      case 'MODULE':
        return { view: 'module', name: hit.name };
      case 'DATA_SOURCE':
        return { view: 'dataSource', name: hit.name };
      case 'FIELD':
        // A field hit is only actionable through its owner.
        return hit.objectName ? { view: 'dataObject', name: hit.objectName } : null;
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Search execution
  // -------------------------------------------------------------------------

  private _debouncedSearch(): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      void this._runSearch();
    }, 300);
  }

  private async _ensureAvailable(): Promise<boolean> {
    if (this._available !== null) {
      return this._available;
    }
    const probe = await this._client!.query('{ s: __type(name: "_SearchResult") { name } }');
    if (probe.errors?.length) {
      // An errored probe answers nothing — caching a verdict from it would
      // pin "upgrade the server" onto a capable engine for the whole
      // connection. Surface the error and let the next search re-probe.
      throw new Error(probe.errors.map((e: any) => e.message).join('; '));
    }
    this._available = !!probe.data?.s?.name;
    return this._available;
  }

  private async _runSearch(): Promise<void> {
    const query = this._query.trim();
    if (!this._client || !query) {
      this._hits = null;
      this._note = '';
      this._renderBody();
      return;
    }
    const version = ++this._searchVersion;
    this._searching = true;
    this._hits = null;
    this._error = null;
    this._renderBody();

    try {
      if (!(await this._ensureAvailable())) {
        if (version !== this._searchVersion) {
          return;
        }
        this._error =
          'This engine does not serve the logical-model search (_search). Upgrade the server.';
        this._searching = false;
        this._renderBody();
        return;
      }
      const resp = await this._client.query(SEARCH_QUERY, {
        q: query,
        m: this._match,
        k: this._kind ? [this._kind] : null,
      });
      this._throwOnErrors(resp);
      if (version !== this._searchVersion) {
        return;
      }
      const page = resp.data?._search;
      this._hits = page?.items ?? [];
      this._note = this._noteFor(page);
    } catch (err) {
      if (version !== this._searchVersion) {
        return;
      }
      this._hits = [];
      this._note = '';
      this._error = err instanceof Error ? err.message : String(err);
    }
    this._searching = false;
    this._renderBody();
  }

  /**
   * What the page says about itself. `lexical` is the one a human still
   * needs: without a vector index the ranking is substring matching and every
   * word has to appear, so "customer orders" finds nothing a semantic ranking
   * would have found. filteredOut says the deployment holds matches this role
   * may not see.
   */
  private _noteFor(page: any): string {
    if (!page) {
      return '';
    }
    const bits: string[] = [];
    if (this._match !== 'NAME' && page.lexical) {
      bits.push('no vector index — substring matching, every word must appear');
    }
    if (page.filteredOut > 0) {
      bits.push(`${page.filteredOut} hidden from you`);
    }
    if (page.hasMore) {
      bits.push('more matches exist — narrow the query');
    }
    return bits.join(' · ');
  }

  private _status(text: string): HTMLElement {
    const div = document.createElement('div');
    div.style.cssText =
      'padding:8px;color:var(--jp-ui-font-color2, #888);font-size:12px;';
    div.textContent = text;
    return div;
  }

  private _throwOnErrors(resp: any): void {
    if (resp?.errors?.length) {
      throw new Error(resp.errors.map((e: any) => e.message).join('; '));
    }
  }
}
