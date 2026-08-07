/**
 * Catalog tree section — hugr's LOGICAL model, lazily loaded.
 *
 * The Schema tab shows the served GraphQL surface: hundreds of generated
 * filters, aggregations and mutation inputs around the handful of things a
 * user actually came to look at. This tab shows the model those were generated
 * FROM — the module tree, the data objects with their relations, the callable
 * functions, and the sources they came from — through the `_catalog` meta
 * queries, which the engine resolves on the metadata path and filters per role.
 *
 * Every level is one query for one node, issued when the node is opened. The
 * meta queries have a depth budget, so asking for the whole tree at once is
 * both slower and liable to be truncated; asking per node never is.
 *
 * The search box on top is `_search`, the engine's own ranking over the same
 * model: semantic where the deployment has an embedder, substring matching
 * where it does not, and it says which. Results replace the tree while a query
 * is present and the tree comes back when it is cleared — one tab, two ways
 * into one model. Engines older than `_search` simply do not get the box.
 */

import { HugrClient } from '../hugrClient';
import { kindIcon, hugrTypeIcon } from './icons';

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

export type CatalogNodeKind =
  | 'group'
  | 'dataSource'
  | 'module'
  | 'dataObject'
  | 'function'
  | 'field'
  | 'relation'
  | 'query'
  | 'arg';

export interface CatalogTreeNode {
  id: string;
  kind: CatalogNodeKind;
  /** Text of the row. */
  label: string;
  /** Right-hand annotation: a GraphQL type, a source name, a relation kind. */
  detail?: string;
  description?: string;
  /** The GraphQL type name this row can open a detail view for. */
  typeName?: string;
  /** Dotted module name — the identity of a module node, and the scope of a member. */
  moduleName?: string;
  expandable: boolean;
  expanded: boolean;
  children: CatalogTreeNode[] | null;
  loading: boolean;
  depth: number;
}

type SearchMatch = 'NAME' | 'MEANING' | 'BOTH';

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
  hugrType?: string;
  refObjectName?: string;
}

let _nextId = 0;
function nextId(): string {
  return `ctn-${_nextId++}`;
}

// ---------------------------------------------------------------------------
// Queries — one per level, all depth 1
// ---------------------------------------------------------------------------

const DATA_SOURCES_QUERY = `{
  _dataSources { name engine description readOnly asModule isExtension modules }
}`;

const MODULE_QUERY = `query($m: String!) {
  _module(name: $m) {
    name
    description
    modules { name description }
    dataObjects { name type description moduleName dataSourceName }
    functions { name type description moduleName dataSourceName }
  }
}`;

const DATA_OBJECT_QUERY = `query($n: String!) {
  _dataObject(name: $n) {
    name
    type
    description
    moduleName
    dataSourceName
    primaryKey
    queries { name type }
    fields {
      name
      description
      hugr_type
      type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
    }
    relations { name kind direction fieldName dataObject { name } }
  }
}`;

const SEARCH_QUERY = `query($q: String!, $m: _SearchMatch!) {
  _search(query: $q, match: $m, limit: 50) {
    lexical
    lexicalReason
    hasMore
    filteredOut
    items {
      kind matchedOn name moduleName dataSourceName description score
      objectName type hugrType refObjectName
    }
  }
}`;

const FUNCTION_QUERY = `query($m: String!, $n: String!) {
  _function(module: $m, name: $n) {
    name
    type
    description
    isTable
    args {
      name
      description
      type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
    }
    returns { name kind ofType { name kind ofType { name kind } } }
  }
}`;

/** Render a possibly-wrapped introspection type as SDL. */
function typeLabel(t: any): string {
  if (!t) {
    return '';
  }
  if (t.name) {
    return t.name;
  }
  const inner = typeLabel(t.ofType);
  if (t.kind === 'NON_NULL') {
    return `${inner}!`;
  }
  if (t.kind === 'LIST') {
    return `[${inner}]`;
  }
  return inner;
}

/** The named type at the bottom of the wrappers — what a detail view opens. */
function namedType(t: any): string | undefined {
  if (!t) {
    return undefined;
  }
  return t.name || namedType(t.ofType);
}

// ---------------------------------------------------------------------------
// CatalogTreeSection
// ---------------------------------------------------------------------------

export class CatalogTreeSection {
  private _container: HTMLElement;
  private _onShowDetail: (typeName: string) => void;
  private _client: HugrClient | null = null;
  private _roots: CatalogTreeNode[] = [];
  private _error: string | null = null;
  /** Null until probed; false on an engine older than _search. */
  private _searchAvailable: boolean | null = null;

  // Search state. An empty query means "show the tree".
  private _query = '';
  // Name and meaning are different questions — see the mode select. BOTH is
  // the default because a user rarely decides in advance which one they are
  // asking.
  private _match: SearchMatch = 'BOTH';
  private _hits: SearchHit[] | null = null;
  private _searching = false;
  private _searchNote = '';
  private _searchVersion = 0;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _searchInput: HTMLInputElement | null = null;
  /** Everything below the search box; the only part a keystroke redraws. */
  private _body: HTMLElement | null = null;

  constructor(container: HTMLElement, onShowDetail: (typeName: string) => void) {
    this._container = container;
    this._onShowDetail = onShowDetail;
  }

  setClient(client: HugrClient | null): void {
    this._client = client;
    this._roots = [];
    this._error = null;
    this._searchAvailable = null;
    this._query = '';
    this._hits = null;
    this._searchNote = '';
    this._render();
    if (client) {
      void this._load();
    }
  }

  refresh(): void {
    if (this._client) {
      this._searchAvailable = null;
      void this._load();
    }
  }

  // -----------------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------------

  private async _load(): Promise<void> {
    if (!this._client) {
      return;
    }
    try {
      // Probe once per connection. The family arrived in v0.3.42, and an
      // engine without it should say so rather than render an empty tree that
      // looks like an empty catalog.
      const probe = await this._client.query(
        '{ m: __type(name: "_Module") { name } s: __type(name: "_SearchResult") { name } }'
      );
      // _search is newer than the rest of the family: an engine can serve the
      // tree and not the search, and then the box has no business being there.
      this._searchAvailable = !!probe.data?.s?.name;
      if (!probe.data?.m?.name) {
        this._error =
          'This engine does not serve the logical-model catalog (_catalog). ' +
          'Use the Schema tab, or upgrade the server.';
        this._render();
        return;
      }
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this._render();
      return;
    }

    this._error = null;
    this._roots = [
      {
        id: nextId(),
        kind: 'group',
        label: 'Modules',
        expandable: true,
        expanded: true,
        children: null,
        loading: false,
        depth: 0,
        moduleName: '',
      },
      {
        id: nextId(),
        kind: 'group',
        label: 'Data Sources',
        expandable: true,
        expanded: false,
        children: null,
        loading: false,
        depth: 0,
      },
    ];
    this._render();
    // The module tree opens expanded: it is the reason to be on this tab.
    void this._loadChildren(this._roots[0]);
  }

  private async _loadChildren(node: CatalogTreeNode): Promise<void> {
    if (!this._client || node.children !== null) {
      return;
    }
    node.loading = true;
    this._renderBody();
    try {
      node.children = await this._fetchChildren(node);
    } catch (err) {
      node.children = [
        {
          id: nextId(),
          kind: 'field',
          label: err instanceof Error ? err.message : String(err),
          expandable: false,
          expanded: false,
          children: null,
          loading: false,
          depth: node.depth + 1,
        },
      ];
    }
    node.loading = false;
    this._renderBody();
  }

  private async _fetchChildren(node: CatalogTreeNode): Promise<CatalogTreeNode[]> {
    const client = this._client!;
    const depth = node.depth + 1;

    if (node.kind === 'group' && node.label === 'Data Sources') {
      const resp = await client.query(DATA_SOURCES_QUERY);
      this._throwOnErrors(resp);
      const sources: any[] = resp.data?._dataSources ?? [];
      return sources.map(s => ({
        id: nextId(),
        kind: 'dataSource' as const,
        label: s.name,
        detail: s.engine || '',
        description: this._sourceDescription(s),
        expandable: false,
        expanded: false,
        children: null,
        loading: false,
        depth,
      }));
    }

    if (node.kind === 'group' || node.kind === 'module') {
      const resp = await client.query(MODULE_QUERY, { m: node.moduleName ?? '' });
      this._throwOnErrors(resp);
      const mod = resp.data?._module;
      if (!mod) {
        return [];
      }
      const out: CatalogTreeNode[] = [];
      for (const m of mod.modules ?? []) {
        out.push({
          id: nextId(),
          kind: 'module',
          label: this._leafName(m.name),
          detail: '',
          description: m.description || '',
          moduleName: m.name,
          expandable: true,
          expanded: false,
          children: null,
          loading: false,
          depth,
        });
      }
      for (const o of mod.dataObjects ?? []) {
        out.push({
          id: nextId(),
          kind: 'dataObject',
          label: o.name,
          detail: (o.type || '').toLowerCase(),
          description: o.description || '',
          typeName: o.name,
          moduleName: o.moduleName ?? '',
          expandable: true,
          expanded: false,
          children: null,
          loading: false,
          depth,
        });
      }
      for (const f of mod.functions ?? []) {
        out.push({
          id: nextId(),
          kind: 'function',
          label: f.name,
          detail: (f.type || '').toLowerCase(),
          description: f.description || '',
          moduleName: f.moduleName ?? '',
          expandable: true,
          expanded: false,
          children: null,
          loading: false,
          depth,
        });
      }
      return out;
    }

    if (node.kind === 'dataObject') {
      const resp = await client.query(DATA_OBJECT_QUERY, { n: node.typeName });
      this._throwOnErrors(resp);
      const obj = resp.data?._dataObject;
      if (!obj) {
        return [];
      }
      const pk: string[] = obj.primaryKey ?? [];
      const out: CatalogTreeNode[] = [];

      // The query NAMES first: they are what a user writes, and they differ
      // from the type name — the type carries the source prefix, the query
      // does not.
      for (const q of obj.queries ?? []) {
        out.push({
          id: nextId(),
          kind: 'query',
          label: q.name,
          detail: (q.type || '').toLowerCase(),
          expandable: false,
          expanded: false,
          children: null,
          loading: false,
          depth,
        });
      }
      for (const f of obj.fields ?? []) {
        const named = namedType(f.type);
        out.push({
          id: nextId(),
          kind: 'field',
          label: pk.includes(f.name) ? `${f.name} 🔑` : f.name,
          detail: typeLabel(f.type),
          description: f.description || '',
          typeName: named,
          expandable: false,
          expanded: false,
          children: null,
          loading: false,
          depth,
        });
      }
      for (const r of obj.relations ?? []) {
        const far = r.dataObject?.name;
        out.push({
          id: nextId(),
          kind: 'relation',
          label: r.fieldName || r.name,
          detail: `${(r.kind || '').toLowerCase()} → ${far ?? '?'}`,
          description: r.description || '',
          typeName: far,
          expandable: false,
          expanded: false,
          children: null,
          loading: false,
          depth,
        });
      }
      return out;
    }

    if (node.kind === 'function') {
      const resp = await client.query(FUNCTION_QUERY, {
        m: node.moduleName ?? '',
        n: node.label,
      });
      this._throwOnErrors(resp);
      const fn = resp.data?._function;
      if (!fn) {
        return [];
      }
      const out: CatalogTreeNode[] = (fn.args ?? []).map((a: any) => ({
        id: nextId(),
        kind: 'arg' as const,
        label: a.name,
        detail: typeLabel(a.type),
        description: a.description || '',
        typeName: namedType(a.type),
        expandable: false,
        expanded: false,
        children: null,
        loading: false,
        depth,
      }));
      const ret = typeLabel(fn.returns);
      if (ret) {
        out.push({
          id: nextId(),
          kind: 'field',
          label: fn.isTable ? 'returns (rows)' : 'returns',
          detail: ret,
          typeName: namedType(fn.returns),
          expandable: false,
          expanded: false,
          children: null,
          loading: false,
          depth,
        });
      }
      return out;
    }

    return [];
  }

  private _sourceDescription(s: any): string {
    const flags: string[] = [];
    if (s.readOnly) {
      flags.push('read-only');
    }
    if (s.asModule) {
      flags.push('as module');
    }
    if (s.isExtension) {
      flags.push('extension');
    }
    const modules = (s.modules ?? []).filter((m: string) => m).join(', ');
    const parts = [s.description, flags.join(', '), modules && `modules: ${modules}`];
    return parts.filter(Boolean).join(' · ');
  }

  /** The last dotted segment — a module row shows its own name, not its path. */
  private _leafName(dotted: string): string {
    const i = dotted.lastIndexOf('.');
    return i >= 0 ? dotted.slice(i + 1) : dotted;
  }

  private _throwOnErrors(resp: any): void {
    if (resp?.errors?.length) {
      throw new Error(resp.errors.map((e: any) => e.message).join('; '));
    }
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  /**
   * Rebuild the whole section: the search box, then the body.
   *
   * Called when the CONNECTION changes, never on a keystroke — the search box
   * is a live DOM node the user is typing into, and re-creating it mid-word
   * moves the caret. Everything that changes while typing goes through
   * _renderBody, which replaces only what is below the box.
   */
  private _render(): void {
    this._container.innerHTML = '';
    this._body = null;

    if (!this._client) {
      this._container.appendChild(this._status('No connection selected'));
      return;
    }
    if (this._error) {
      const err = this._status(this._error);
      err.style.color = 'var(--jp-error-color1, #d32f2f)';
      this._container.appendChild(err);
      return;
    }

    if (this._searchAvailable) {
      this._container.appendChild(this._searchBox());
    }

    const body = document.createElement('div');
    this._body = body;
    this._container.appendChild(body);
    this._renderBody();
  }

  private _renderBody(): void {
    const body = this._body;
    if (!body) {
      return;
    }
    body.innerHTML = '';

    // A query in the box replaces the tree; clearing it brings the tree back
    // with every node still open where the user left it.
    if (this._query.trim()) {
      body.appendChild(this._renderHits());
      return;
    }

    if (this._roots.length === 0) {
      body.appendChild(this._status('Loading…'));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const root of this._roots) {
      this._renderNode(root, fragment);
    }
    body.appendChild(fragment);
  }

  private _searchBox(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:4px;display:flex;gap:4px;align-items:center;';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search the model by meaning…';
    input.value = this._query;
    input.style.cssText = 'flex:1;min-width:0;';
    input.addEventListener('input', () => {
      const hadQuery = this._query.trim() !== '';
      this._query = input.value;
      if (this._query.trim() === '') {
        // Emptying the box is not a search — go straight back to the tree.
        this._hits = null;
        this._searchNote = '';
        this._renderBody();
        return;
      }
      if (!hadQuery) {
        // First character: swap the tree out for the pending state now, so the
        // panel does not sit on a stale tree until the debounce fires.
        this._renderBody();
      }
      this._debouncedSearch();
    });
    this._searchInput = input;
    wrap.appendChild(input);

    const mode = document.createElement('select');
    mode.title =
      'What to match on. A name never enters the vector index — that is built ' +
      'from descriptions — so an identifier is only findable by name.';
    mode.style.cssText = 'flex:none;';
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
        this._hits = null;
        void this._runSearch();
      }
    });
    wrap.appendChild(mode);

    const clear = document.createElement('button');
    clear.textContent = '×';
    clear.title = 'Back to the tree';
    clear.style.cssText = 'flex:none;cursor:pointer;';
    clear.addEventListener('click', () => {
      this._query = '';
      input.value = '';
      this._hits = null;
      this._searchNote = '';
      this._renderBody();
    });
    wrap.appendChild(clear);

    return wrap;
  }

  private _renderHits(): HTMLElement {
    const box = document.createElement('div');

    if (this._hits === null) {
      // Typed, but the debounce has not fired yet — or the first search is
      // still in flight. Either way nothing has been ANSWERED, and saying
      // "nothing matches" here would be a lie the user acts on.
      box.appendChild(this._status('Searching…'));
      return box;
    }
    if (this._searchNote) {
      const note = this._status(this._searchNote);
      note.style.fontStyle = 'italic';
      box.appendChild(note);
    }
    const hits = this._hits ?? [];
    if (hits.length === 0 && !this._searching) {
      box.appendChild(this._status('Nothing matches'));
      return box;
    }

    for (const hit of hits) {
      box.appendChild(this._hitRow(hit));
    }
    return box;
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

    // A field hit is only actionable through its owner, so that is what the
    // row names and what clicking it opens.
    const target = hit.kind === 'FIELD' ? hit.objectName : hit.name;
    const label = document.createElement('span');
    label.textContent =
      hit.kind === 'FIELD' ? `${hit.objectName}.${hit.name}` : hit.name;
    label.style.cssText = 'font-weight:500;';
    if (target) {
      label.style.cursor = 'pointer';
      label.addEventListener('click', () => this._onShowDetail(target));
    }
    row.appendChild(label);

    // Which track found it. Worth showing: an exact name and an embedding
    // distance are not on one scale, so a NAME hit at 1.0 and a MEANING hit at
    // 0.6 are not "better" and "worse", they are answers to different
    // questions.
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
      case 'DATA_OBJECT':
        return hugrTypeIcon('table');
      case 'FUNCTION':
        return hugrTypeIcon('function');
      case 'DATA_SOURCE':
        return kindIcon('OBJECT');
      default:
        return kindIcon('SCALAR');
    }
  }

  private _debouncedSearch(): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      void this._runSearch();
    }, 300);
  }

  private async _runSearch(): Promise<void> {
    const query = this._query.trim();
    if (!this._client || !query) {
      this._hits = null;
      this._searchNote = '';
      this._renderBody();
      return;
    }
    const version = ++this._searchVersion;
    this._searching = true;
    this._renderBody();

    try {
      const resp = await this._client.query(SEARCH_QUERY, { q: query, m: this._match });
      this._throwOnErrors(resp);
      if (version !== this._searchVersion) {
        return;
      }
      const page = resp.data?._search;
      this._hits = page?.items ?? [];
      this._searchNote = this._noteFor(page);
    } catch (err) {
      if (version !== this._searchVersion) {
        return;
      }
      this._hits = [];
      this._searchNote = err instanceof Error ? err.message : String(err);
    }
    this._searching = false;
    this._renderBody();
  }

  /**
   * What the page says about itself. `lexical` is the one an agent-free human
   * still needs: without a vector index the ranking is substring matching and
   * every word has to appear, so "customer orders" finds nothing that a
   * semantic ranking would have found.
   */
  private _noteFor(page: any): string {
    if (!page) {
      return '';
    }
    const bits: string[] = [];
    if (this._match === 'NAME') {
      bits.push('matching names only');
    } else if (page.lexical) {
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

  private _renderNode(
    node: CatalogTreeNode,
    parent: DocumentFragment | HTMLElement
  ): void {
    parent.appendChild(this._createRow(node));

    if (node.loading) {
      const loading = document.createElement('div');
      loading.className = 'hugr-schema-tree-row';
      loading.style.cssText =
        `padding:2px 4px 2px ${(node.depth + 1) * 16 + 20}px;` +
        'color:var(--jp-ui-font-color2, #888);font-size:11px;font-style:italic;';
      loading.textContent = 'Loading…';
      parent.appendChild(loading);
    }

    if (node.expanded && node.children) {
      for (const child of node.children) {
        this._renderNode(child, parent);
      }
    }
  }

  private _createRow(node: CatalogTreeNode): HTMLElement {
    const row = document.createElement('div');
    row.className = 'hugr-schema-tree-row';
    row.style.cssText =
      `display:flex;align-items:center;gap:4px;padding:2px 4px 2px ${node.depth * 16 + 4}px;` +
      'font-size:12px;cursor:default;white-space:nowrap;';

    const twisty = document.createElement('span');
    twisty.style.cssText = 'width:14px;flex:none;text-align:center;';
    if (node.expandable) {
      twisty.textContent = node.expanded ? '▾' : '▸';
      twisty.style.cursor = 'pointer';
      twisty.addEventListener('click', () => void this._toggle(node));
    }
    row.appendChild(twisty);

    const icon = document.createElement('span');
    icon.style.cssText = 'flex:none;display:inline-flex;';
    icon.innerHTML = this._icon(node);
    row.appendChild(icon);

    const label = document.createElement('span');
    label.textContent = node.label;
    label.style.cssText = 'font-weight:500;';
    if (node.expandable) {
      label.style.cursor = 'pointer';
      label.addEventListener('click', () => void this._toggle(node));
    } else if (node.typeName) {
      label.style.cursor = 'pointer';
      label.addEventListener('click', () => this._onShowDetail(node.typeName!));
    }
    row.appendChild(label);

    if (node.detail) {
      const detail = document.createElement('span');
      detail.textContent = node.detail;
      // The detail slot carries different things per row — a GraphQL type, a
      // source engine, a relation target — so it takes the muted annotation
      // colour rather than a per-hugr-type one.
      detail.style.cssText =
        'color:var(--jp-ui-font-color2, #888);font-size:11px;opacity:0.9;';
      row.appendChild(detail);
    }

    if (node.description) {
      const desc = document.createElement('span');
      desc.textContent = node.description;
      desc.style.cssText =
        'color:var(--jp-ui-font-color2, #888);font-size:11px;' +
        'overflow:hidden;text-overflow:ellipsis;';
      desc.title = node.description;
      row.appendChild(desc);
    }

    return row;
  }

  private _icon(node: CatalogTreeNode): string {
    switch (node.kind) {
      case 'module':
      case 'group':
        return hugrTypeIcon('module');
      case 'dataObject':
        return hugrTypeIcon(node.detail === 'view' ? 'view' : 'table');
      case 'function':
        return hugrTypeIcon('function');
      case 'dataSource':
        return kindIcon('OBJECT');
      case 'relation':
        return kindIcon('INTERFACE');
      default:
        return kindIcon('SCALAR');
    }
  }

  private async _toggle(node: CatalogTreeNode): Promise<void> {
    if (!node.expandable) {
      return;
    }
    node.expanded = !node.expanded;
    if (node.expanded && node.children === null) {
      await this._loadChildren(node);
      return;
    }
    this._renderBody();
  }
}
