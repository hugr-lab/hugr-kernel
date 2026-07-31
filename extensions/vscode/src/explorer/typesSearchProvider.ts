/**
 * Types Search WebviewViewProvider for VS Code.
 *
 * A sidebar webview listing the GraphQL types the connected engine serves —
 * the generated surface included, which is what makes it useful: filters,
 * aggregations and mutation inputs are most of what a schema is made of, and
 * they are exactly the names that turn up in an error message.
 *
 * The listing comes from standard introspection (`__schema.types`, with hugr's
 * `hugr_type` / `module` / `catalog` extensions) and is cached per connection,
 * then filtered and paged locally. It used to be a server-side query over
 * `core.catalog.types`; that view belonged to the compiled-schema storage and
 * went with it — the schema is generated on read now, so there is no table of
 * generated types left to page through. Semantic search went the same way: the
 * vector index covers the LOGICAL model, never the generated types.
 *
 * Ported from JupyterLab typesSearch.ts — keep the two in step.
 */
import * as vscode from 'vscode';
import { HugrClient } from './hugrClient';
import { kindIconSvg, kindColor, hugrTypeColor, hugrTypeLabel, KIND_LABELS } from './icons';

const PAGE_SIZE = 15;

export class TypesSearchProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | null = null;
  private _client: HugrClient | null = null;
  private _extensionUri: vscode.Uri;

  // Search state
  private _query = '';
  private _kindFilter = '';
  private _page = 0;
  private _totalCount = 0;
  private _results: any[] = [];
  private _loading = false;
  private _error: string | null = null;
  private _searchVersion = 0;
  // The connection's whole type list, fetched once. ~3k types on a large
  // deployment: half a megabyte, and then every keystroke is local.
  private _allTypes: any[] | null = null;

  private _onShowTypeDetail: (typeName: string) => void;

  constructor(extensionUri: vscode.Uri, onShowTypeDetail: (typeName: string) => void) {
    this._extensionUri = extensionUri;
    this._onShowTypeDetail = onShowTypeDetail;
  }

  setClient(client: HugrClient | null): void {
    this._client = client;
    this._query = '';
    this._kindFilter = '';
    this._page = 0;
    this._totalCount = 0;
    this._results = [];
    this._loading = false;
    this._error = null;
    this._allTypes = null;
    this._updateWebview();
    if (client) {
      this._search();
    }
  }

  searchFor(typeName: string): void {
    this._query = typeName;
    this._page = 0;
    this._updateWebview();
    this._search();
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
          this._page = 0;
          this._search();
          break;
        case 'filter':
          this._kindFilter = msg.kind ?? '';
          this._page = 0;
          this._search();
          break;
        case 'page':
          this._page = msg.page ?? 0;
          this._search();
          break;
        case 'showType':
          if (msg.typeName) {
            this._onShowTypeDetail(msg.typeName);
          }
          break;
      }
    });

    this._updateWebview();
  }

  // -------------------------------------------------------------------------
  // Search execution
  // -------------------------------------------------------------------------

  private async _search(): Promise<void> {
    if (!this._client) return;

    const version = ++this._searchVersion;
    this._loading = true;
    this._postMessage({ command: 'loading', loading: true });

    try {
      await this._ensureTypes();
      this._error = null;
      this._applyFilter();
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this._results = [];
      this._totalCount = 0;
    }

    if (version !== this._searchVersion) return;

    this._loading = false;
    this._postMessage({
      command: 'results',
      results: this._results.map(r => {
        // Validate kind against known values to prevent SVG injection
        const safeKind = (r.kind && r.kind in KIND_LABELS) ? r.kind : '';
        return {
        name: r.name || '',
        kind: safeKind,
        kindIcon: kindIconSvg(safeKind),
        description: r.description || '',
        hugrType: r.hugr_type || '',
        hugrTypeLabel: r.hugr_type ? hugrTypeLabel(r.hugr_type) : '',
        hugrTypeColor: r.hugr_type ? hugrTypeColor(r.hugr_type) : '',
        module: r.module || '',
        catalog: r.catalog || '',
      }; }),
      totalCount: this._totalCount,
      page: this._page,
      pageSize: PAGE_SIZE,
      error: this._error,
    });
  }

  private _postMessage(msg: any): void {
    this._view?.webview.postMessage(msg);
  }

  /**
   * Fetch the connection's type list once and keep it.
   *
   * Standard introspection has no filter, no ordering and no pagination, so
   * the choice is one payload per connection or one per keystroke; the list
   * only changes when a data source is loaded or unloaded, which is what
   * reconnecting is for.
   */
  private async _ensureTypes(): Promise<void> {
    if (this._allTypes !== null || !this._client) return;
    const resp = await this._client.query(`{
  __schema {
    types { name kind description hugr_type module catalog }
  }
}`);
    if (resp.errors && resp.errors.length > 0) {
      throw new Error(resp.errors.map((e: any) => e.message).join('; '));
    }
    const types: any[] = resp.data?.__schema?.types ?? [];
    // Introspection's own types are not part of anyone's schema.
    this._allTypes = types
      .filter(t => t.name && !t.name.startsWith('__'))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  /**
   * Narrow the cached list and cut the requested page out of it.
   *
   * The matching rule is the one the server-side ilike used to implement, kept
   * so muscle memory survives the move: bare text is a PREFIX match, and a `*`
   * anywhere makes the whole pattern a wildcard match. Both case-insensitive.
   */
  private _applyFilter(): void {
    const all = this._allTypes ?? [];
    const matches = this._matcher(this._query.trim());

    const filtered = all.filter(t => {
      if (this._kindFilter && t.kind !== this._kindFilter) return false;
      return matches(t.name);
    });

    this._totalCount = filtered.length;
    const start = this._page * PAGE_SIZE;
    if (start >= filtered.length && this._page > 0) {
      // The filter narrowed past the current page — go back to the first one
      // rather than showing an empty list under a "46-60 of 12".
      this._page = 0;
      this._results = filtered.slice(0, PAGE_SIZE);
      return;
    }
    this._results = filtered.slice(start, start + PAGE_SIZE);
  }

  private _matcher(query: string): (name: string) => boolean {
    if (!query) return () => true;
    const needle = query.toLowerCase();
    if (!needle.includes('*')) {
      return name => name.toLowerCase().startsWith(needle);
    }
    // Escape everything a user might type, then let `*` through as `.*`.
    const pattern = needle
      .split('*')
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    const re = new RegExp(`^${pattern}$`);
    return name => re.test(name.toLowerCase());
  }

  private _updateWebview(): void {
    if (!this._view) return;
    this._view.webview.html = this._getHtml();
  }

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
  .filters {
    display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px;
  }
  .filter-row {
    display: flex; gap: 6px; align-items: center;
  }
  input[type="text"] {
    flex: 1; padding: 4px 8px; border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 3px; font-size: 12px;
    outline: none;
  }
  input[type="text"]:focus {
    border-color: var(--vscode-focusBorder);
  }
  select {
    padding: 4px; border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 3px; font-size: 11px;
  }
  label { font-size: 11px; display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  .results { margin-top: 4px; }
  .result-row {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 6px; cursor: pointer; border-radius: 3px;
  }
  .result-row:hover { background: var(--vscode-list-hoverBackground); }
  .result-icon { flex-shrink: 0; width: 16px; height: 16px; display: flex; align-items: center; }
  .result-icon svg { width: 16px; height: 16px; }
  .result-name { font-weight: 500; flex-shrink: 0; }
  .result-module { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .result-fields { color: var(--vscode-descriptionForeground); font-size: 10px; flex-shrink: 0; }
  .result-desc {
    color: var(--vscode-descriptionForeground); font-size: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .hugr-badge {
    padding: 0 4px; border-radius: 3px; font-size: 10px;
    flex-shrink: 0;
  }
  .pagination {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 8px; font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .page-btns { display: flex; gap: 4px; }
  .page-btn {
    padding: 2px 8px; border: 1px solid var(--vscode-button-border, var(--vscode-input-border));
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border-radius: 3px; font-size: 11px; cursor: pointer;
  }
  .page-btn:disabled { opacity: 0.5; cursor: default; }
  .page-btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .status { padding: 16px 8px; text-align: center; color: var(--vscode-descriptionForeground); font-style: italic; }
</style>
</head>
<body>
  <div class="filters">
    <input type="text" id="searchInput" placeholder="Search types... (use * for wildcard)" value="${this._escAttr(this._query)}" />
    <div class="filter-row">
      <select id="kindFilter">
        <option value="">All kinds</option>
        <option value="OBJECT" ${this._kindFilter === 'OBJECT' ? 'selected' : ''}>Object</option>
        <option value="INPUT_OBJECT" ${this._kindFilter === 'INPUT_OBJECT' ? 'selected' : ''}>Input</option>
        <option value="ENUM" ${this._kindFilter === 'ENUM' ? 'selected' : ''}>Enum</option>
        <option value="SCALAR" ${this._kindFilter === 'SCALAR' ? 'selected' : ''}>Scalar</option>
        <option value="INTERFACE" ${this._kindFilter === 'INTERFACE' ? 'selected' : ''}>Interface</option>
        <option value="UNION" ${this._kindFilter === 'UNION' ? 'selected' : ''}>Union</option>
      </select>
    </div>
  </div>
  <div id="results" class="results">
    <div class="status">${this._client ? 'Type to search' : 'No connection'}</div>
  </div>
  <div id="pagination" class="pagination" style="display:none"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('searchInput');
    const kindFilter = document.getElementById('kindFilter');
    const resultsDiv = document.getElementById('results');
    const paginationDiv = document.getElementById('pagination');

    let debounceTimer = null;

    searchInput.addEventListener('input', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        vscode.postMessage({ command: 'search', query: searchInput.value });
      }, 300);
    });

    kindFilter.addEventListener('change', () => {
      vscode.postMessage({ command: 'filter', kind: kindFilter.value });
    });


    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.command === 'loading') {
        resultsDiv.innerHTML = '<div class="status">Loading...</div>';
        paginationDiv.style.display = 'none';
      }

      if (msg.command === 'results') {
        if (msg.error) {
          // A failed listing must not read as an empty catalog.
          resultsDiv.innerHTML = '<div class="status">' + esc(msg.error) + '</div>';
          paginationDiv.style.display = 'none';
          return;
        }
        if (msg.results.length === 0) {
          resultsDiv.innerHTML = '<div class="status">No results</div>';
          paginationDiv.style.display = 'none';
          return;
        }

        let html = '';
        for (const r of msg.results) {
          const badge = r.hugrType
            ? '<span class="hugr-badge" style="background:' + r.hugrTypeColor + '22;color:' + r.hugrTypeColor + '">' + esc(r.hugrTypeLabel) + '</span>'
            : '';
          html += '<div class="result-row" data-type="' + escAttr(r.name) + '">'
            + '<span class="result-icon">' + r.kindIcon + '</span>'
            + '<span class="result-name">' + esc(r.name) + '</span>'
            + badge
            + (r.module ? '<span class="result-module">' + esc(r.module) + '</span>' : '')
            + (r.catalog ? '<span class="result-fields">' + esc(r.catalog) + '</span>' : '')
            + '</div>';
        }
        resultsDiv.innerHTML = html;

        // Pagination
        if (msg.totalCount > 0) {
          const start = msg.page * msg.pageSize + 1;
          const end = Math.min((msg.page + 1) * msg.pageSize, msg.totalCount);
          paginationDiv.style.display = 'flex';
          paginationDiv.innerHTML =
            '<span>' + start + '-' + end + ' of ' + msg.totalCount + '</span>' +
            '<div class="page-btns">' +
            '<button class="page-btn" id="prevBtn"' + (msg.page === 0 ? ' disabled' : '') + '>Prev</button>' +
            '<button class="page-btn" id="nextBtn"' + (end >= msg.totalCount ? ' disabled' : '') + '>Next</button>' +
            '</div>';

          document.getElementById('prevBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'page', page: msg.page - 1 });
          });
          document.getElementById('nextBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'page', page: msg.page + 1 });
          });
        } else {
          paginationDiv.style.display = 'none';
        }

        // Click handlers
        resultsDiv.querySelectorAll('.result-row').forEach(row => {
          row.addEventListener('click', () => {
            vscode.postMessage({ command: 'showType', typeName: row.getAttribute('data-type') });
          });
        });
      }

      if (msg.command === 'setQuery') {
        searchInput.value = msg.query || '';
      }
    });

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
