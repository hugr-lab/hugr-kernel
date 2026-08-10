/**
 * Search WebviewViewProvider for VS Code — `_search` over hugr's LOGICAL model.
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
 * Ported from JupyterLab searchSection.ts — keep the two in step.
 */
import * as vscode from 'vscode';
import { HugrClient } from './hugrClient';
import { hugrTypeColor } from './icons';
import type { DetailTarget } from './detailPanel';

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

const GROUP_ORDER: Array<[string, string]> = [
  ['DATA_OBJECT', 'Data objects'],
  ['FUNCTION', 'Functions'],
  ['MODULE', 'Modules'],
  ['DATA_SOURCE', 'Data sources'],
  ['FIELD', 'Fields'],
];

export class SearchViewProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | null = null;
  private _client: HugrClient | null = null;
  private _extensionUri: vscode.Uri;
  private _onOpen: (target: DetailTarget) => void;

  private _query = '';
  private _match: SearchMatch = 'BOTH';
  private _kind = '';
  /** Null until probed for this connection; false on an engine without _search. */
  private _available: boolean | null = null;
  private _searchVersion = 0;

  constructor(extensionUri: vscode.Uri, onOpen: (target: DetailTarget) => void) {
    this._extensionUri = extensionUri;
    this._onOpen = onOpen;
  }

  setClient(client: HugrClient | null): void {
    this._client = client;
    this._query = '';
    this._available = null;
    this._searchVersion++;
    this._updateWebview();
  }

  /** Cross-references land here: put the name in the box and run it. */
  searchFor(query: string): void {
    this._query = query;
    // A stale kind restriction would silently exclude what the caller is
    // pointing at — a cross-reference always searches all kinds.
    this._kind = '';
    this._postMessage({ command: 'setQuery', query });
    this._postMessage({ command: 'setKind', kind: '' });
    void this._search();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.onDidReceiveMessage((msg) => {
      switch (msg.command) {
        case 'search':
          this._query = msg.query ?? '';
          void this._search();
          break;
        case 'match':
          this._match = msg.match === 'NAME' || msg.match === 'MEANING' ? msg.match : 'BOTH';
          if (this._query.trim()) void this._search();
          break;
        case 'kind':
          this._kind = typeof msg.kind === 'string' ? msg.kind : '';
          if (this._query.trim()) void this._search();
          break;
        case 'open':
          if (msg.target?.view && msg.target?.name != null) {
            this._onOpen(msg.target as DetailTarget);
          }
          break;
      }
    });

    this._updateWebview();
    // A cross-reference may have set the query before the view first
    // resolved — run it now, or the box shows a query that never searched.
    if (this._client && this._query.trim()) {
      void this._search();
    }
  }

  // -------------------------------------------------------------------------
  // Search execution
  // -------------------------------------------------------------------------

  private async _ensureAvailable(): Promise<boolean> {
    if (this._available !== null) return this._available;
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

  private async _search(): Promise<void> {
    if (!this._client || !this._view) return;
    const query = this._query.trim();
    const version = ++this._searchVersion;
    if (!query) {
      this._postMessage({ command: 'results', groups: [], note: '', idle: true });
      return;
    }
    this._postMessage({ command: 'loading' });
    try {
      if (!(await this._ensureAvailable())) {
        if (version !== this._searchVersion) return;
        this._postMessage({
          command: 'results',
          groups: [],
          note: '',
          error: 'This engine does not serve the logical-model search (_search). Upgrade the server.',
        });
        return;
      }
      const resp = await this._client.query(SEARCH_QUERY, {
        q: query,
        m: this._match,
        k: this._kind ? [this._kind] : null,
      });
      if (resp.errors?.length) {
        throw new Error(resp.errors.map((e: any) => e.message).join('; '));
      }
      if (version !== this._searchVersion) return;
      const page = resp.data?._search;
      this._postMessage({
        command: 'results',
        groups: this._groups(page),
        note: this._noteFor(page),
        // _search covers the LOGICAL model only. A generated type name (a
        // filter, an aggregation — the names error messages cite) is not in
        // it, but any exact name still opens through __type — offer that
        // whenever the query looks like one identifier.
        exactLookup: /^[A-Za-z_][A-Za-z0-9_]*$/.test(query) ? query : '',
      });
    } catch (err) {
      if (version !== this._searchVersion) return;
      this._postMessage({
        command: 'results',
        groups: [],
        note: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * One flat list reads fine when everything in it is the same thing; a mixed
   * one buries the three tables the user wanted under a page of field hits.
   * Group by entity kind — objects first, fields last — as soon as kinds mix.
   */
  private _groups(page: any): any[] {
    const byKind = new Map<string, any[]>();
    for (const h of page?.items ?? []) {
      const row = this._row(h);
      if (!row) continue;
      const bucket = byKind.get(h.kind);
      if (bucket) {
        bucket.push(row);
      } else {
        byKind.set(h.kind, [row]);
      }
    }
    const known = new Set(GROUP_ORDER.map(([k]) => k));
    const groups: any[] = [];
    for (const [k, label] of GROUP_ORDER) {
      const rows = byKind.get(k);
      if (rows?.length) groups.push({ label, rows });
    }
    for (const [k, rows] of byKind) {
      if (!known.has(k) && rows.length) groups.push({ label: k, rows });
    }
    return groups;
  }

  private _row(h: any): any | null {
    const isField = h.kind === 'FIELD';
    const target = this._hitOpen(h);
    if (!target) return null;
    const detail = [
      isField ? h.type : '',
      h.moduleName ? `in ${h.moduleName}` : '',
      h.refObjectName ? `→ ${h.refObjectName}` : '',
    ]
      .filter(Boolean)
      .join('  ');
    return {
      label: isField ? `${h.objectName}.${h.name}` : h.name,
      detail,
      description: h.description || '',
      // Mark which track found it. An exact name and an embedding distance
      // are not on one scale, so a name hit is not "better" than a meaning
      // hit — it is an answer to a different question.
      nameMatch: h.matchedOn === 'NAME',
      badge: this._badge(h),
      target,
    };
  }

  private _badge(h: any): { text: string; color: string } {
    switch (h.kind) {
      case 'DATA_OBJECT': {
        // Table-vs-view comes from the dataObject drill-down, which the
        // engine has already resolved for the permission check.
        const isView = h.dataObject?.type === 'VIEW';
        return {
          text: isView ? 'View' : 'Table',
          color: hugrTypeColor(isView ? 'view' : 'table'),
        };
      }
      case 'FUNCTION':
        return { text: 'Fn', color: hugrTypeColor('function') };
      case 'MODULE':
        return { text: 'Module', color: hugrTypeColor('module') };
      case 'DATA_SOURCE':
        return { text: 'Source', color: hugrTypeColor('module') };
      default:
        return { text: 'Field', color: hugrTypeColor('extra_field') };
    }
  }

  /** Where a hit navigates: every hit kind has a catalog detail view. */
  private _hitOpen(h: any): DetailTarget | undefined {
    switch (h.kind) {
      case 'DATA_OBJECT':
        return { view: 'dataObject', name: h.name };
      case 'FUNCTION':
        return { view: 'function', name: h.name, module: h.moduleName ?? '' };
      case 'MODULE':
        return { view: 'module', name: h.name };
      case 'DATA_SOURCE':
        return { view: 'dataSource', name: h.name };
      case 'FIELD':
        // A field hit is only actionable through its owner.
        return h.objectName ? { view: 'dataObject', name: h.objectName } : undefined;
      default:
        return undefined;
    }
  }

  /**
   * What the page says about itself. `lexical` is the one a human still
   * needs: without a vector index the ranking is substring matching and every
   * word has to appear, so "customer orders" finds nothing a semantic ranking
   * would have found. filteredOut says the deployment holds matches this role
   * may not see.
   */
  private _noteFor(page: any): string {
    if (!page) return '';
    const bits: string[] = [];
    if (this._match !== 'NAME' && page.lexical) {
      bits.push('no vector index — substring matching, every word must appear');
    }
    if (page.filteredOut > 0) bits.push(`${page.filteredOut} hidden from you`);
    if (page.hasMore) bits.push('more matches exist — narrow the query');
    return bits.join(' · ');
  }

  private _postMessage(msg: any): void {
    this._view?.webview.postMessage(msg);
  }

  private _updateWebview(): void {
    if (!this._view) return;
    this._view.webview.html = this._getHtml();
  }

  // -------------------------------------------------------------------------
  // Webview HTML
  // -------------------------------------------------------------------------

  private _getHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<style>
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 8px;
    margin: 0;
  }
  .filters { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .filter-row { display: flex; gap: 6px; align-items: center; }
  input[type="text"] {
    flex: 1; padding: 4px 8px; border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 3px; font-size: 12px;
    outline: none;
  }
  input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
  select {
    flex: 1; min-width: 0;
    padding: 4px; border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 3px; font-size: 11px;
  }
  .note {
    color: var(--vscode-descriptionForeground); font-size: 11px;
    font-style: italic; padding: 0 2px 6px;
  }
  .group-header {
    padding: 6px 2px 2px; font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
  }
  .result-row {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 6px; cursor: pointer; border-radius: 3px;
    white-space: nowrap; overflow: hidden;
  }
  .result-row:hover { background: var(--vscode-list-hoverBackground); }
  .kind-badge {
    flex-shrink: 0; padding: 0 4px; border-radius: 3px; font-size: 10px;
  }
  .result-name { font-weight: 500; flex-shrink: 0; }
  .name-badge {
    flex-shrink: 0; padding: 0 4px; border-radius: 3px; font-size: 10px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .result-meta { color: var(--vscode-descriptionForeground); font-size: 11px; flex-shrink: 0; }
  .result-desc {
    color: var(--vscode-descriptionForeground); font-size: 11px;
    overflow: hidden; text-overflow: ellipsis;
  }
  .status { padding: 16px 8px; text-align: center; color: var(--vscode-descriptionForeground); font-style: italic; }
  .lookup-row {
    padding: 4px 6px; margin-bottom: 4px; cursor: pointer; border-radius: 3px;
    color: var(--vscode-textLink-foreground); font-size: 11px;
  }
  .lookup-row:hover { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
  <div class="filters">
    <input type="text" id="searchInput" placeholder="Describe the data in your own words…" value="${this._escAttr(this._query)}" />
    <div class="filter-row">
      <select id="matchSelect" title="What to match on. A name never enters the vector index — that is built from descriptions — so an identifier is only findable by name.">
        <option value="BOTH" ${this._match === 'BOTH' ? 'selected' : ''}>Name + meaning</option>
        <option value="NAME" ${this._match === 'NAME' ? 'selected' : ''}>Name</option>
        <option value="MEANING" ${this._match === 'MEANING' ? 'selected' : ''}>Meaning</option>
      </select>
      <select id="kindSelect" title="Restrict to one entity kind">
        <option value="" ${this._kind === '' ? 'selected' : ''}>All kinds</option>
        <option value="DATA_OBJECT" ${this._kind === 'DATA_OBJECT' ? 'selected' : ''}>Data objects</option>
        <option value="FUNCTION" ${this._kind === 'FUNCTION' ? 'selected' : ''}>Functions</option>
        <option value="MODULE" ${this._kind === 'MODULE' ? 'selected' : ''}>Modules</option>
        <option value="DATA_SOURCE" ${this._kind === 'DATA_SOURCE' ? 'selected' : ''}>Data sources</option>
        <option value="FIELD" ${this._kind === 'FIELD' ? 'selected' : ''}>Fields</option>
      </select>
    </div>
  </div>
  <div id="note" class="note" style="display:none"></div>
  <div id="results">
    <div class="status">${this._client ? 'Describe the data you are looking for' : 'No connection'}</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('searchInput');
    const matchSelect = document.getElementById('matchSelect');
    const kindSelect = document.getElementById('kindSelect');
    const resultsDiv = document.getElementById('results');
    const noteDiv = document.getElementById('note');

    let debounceTimer = null;

    searchInput.addEventListener('input', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        vscode.postMessage({ command: 'search', query: searchInput.value });
      }, 300);
    });

    matchSelect.addEventListener('change', () => {
      vscode.postMessage({ command: 'match', match: matchSelect.value });
    });

    kindSelect.addEventListener('change', () => {
      vscode.postMessage({ command: 'kind', kind: kindSelect.value });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.command === 'setQuery') {
        searchInput.value = msg.query || '';
        return;
      }

      if (msg.command === 'setKind') {
        kindSelect.value = msg.kind || '';
        return;
      }

      if (msg.command === 'loading') {
        resultsDiv.innerHTML = '<div class="status">Searching…</div>';
        noteDiv.style.display = 'none';
        return;
      }

      if (msg.command !== 'results') return;

      if (msg.error) {
        resultsDiv.innerHTML = '<div class="status">' + esc(msg.error) + '</div>';
        noteDiv.style.display = 'none';
        return;
      }
      if (msg.idle) {
        resultsDiv.innerHTML = '<div class="status">Describe the data you are looking for</div>';
        noteDiv.style.display = 'none';
        return;
      }

      if (msg.note) {
        noteDiv.textContent = msg.note;
        noteDiv.style.display = '';
      } else {
        noteDiv.style.display = 'none';
      }

      const lookup = msg.exactLookup
        ? '<div class="lookup-row" id="lookupRow" data-type="' + escAttr(msg.exactLookup) + '">'
          + 'Open <strong>' + esc(msg.exactLookup) + '</strong> as GraphQL type ↗</div>'
        : '';

      if (!msg.groups.length) {
        resultsDiv.innerHTML = lookup + '<div class="status">Nothing matches</div>';
        wireLookup();
        return;
      }

      let html = lookup;
      const showHeaders = msg.groups.length > 1;
      for (const g of msg.groups) {
        if (showHeaders) {
          html += '<div class="group-header">' + esc(g.label) + ' (' + g.rows.length + ')</div>';
        }
        for (const r of g.rows) {
          html += '<div class="result-row" data-target="' + escAttr(JSON.stringify(r.target)) + '">'
            + '<span class="kind-badge" style="background:' + r.badge.color + '22;color:' + r.badge.color + '">' + esc(r.badge.text) + '</span>'
            + '<span class="result-name">' + esc(r.label) + '</span>'
            + (r.nameMatch ? '<span class="name-badge">name</span>' : '')
            + (r.detail ? '<span class="result-meta">' + esc(r.detail) + '</span>' : '')
            + (r.description ? '<span class="result-desc">' + esc(r.description) + '</span>' : '')
            + '</div>';
        }
      }
      resultsDiv.innerHTML = html;

      resultsDiv.querySelectorAll('.result-row').forEach(row => {
        row.addEventListener('click', () => {
          try {
            vscode.postMessage({ command: 'open', target: JSON.parse(row.getAttribute('data-target')) });
          } catch {}
        });
      });
      wireLookup();
    });

    function wireLookup() {
      const row = document.getElementById('lookupRow');
      if (row) {
        row.addEventListener('click', () => {
          vscode.postMessage({ command: 'open', target: { view: 'type', name: row.getAttribute('data-type') } });
        });
      }
    }

    function esc(text) {
      const d = document.createElement('div');
      d.textContent = text;
      return d.innerHTML;
    }
    function escAttr(text) {
      return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  </script>
</body>
</html>`;
  }

  private _escAttr(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
