/**
 * Types Search WebviewViewProvider for VS Code.
 *
 * Provides a sidebar webview with search input, kind filter,
 * paginated results, and click-to-detail navigation.
 * Ported from JupyterLab typesSearch.ts.
 */
import * as vscode from 'vscode';
import { HugrClient } from './hugrClient';
import { kindIconSvg, kindColor, hugrTypeColor, hugrTypeLabel } from './icons';

const PAGE_SIZE = 15;

export class TypesSearchProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | null = null;
  private _client: HugrClient | null = null;
  private _extensionUri: vscode.Uri;

  // Search state
  private _query = '';
  private _kindFilter = '';
  private _semanticSearch = false;
  private _page = 0;
  private _totalCount = 0;
  private _results: any[] = [];
  private _loading = false;
  private _semanticAvailable = true;
  private _searchVersion = 0;

  private _onShowTypeDetail: (typeName: string) => void;

  constructor(extensionUri: vscode.Uri, onShowTypeDetail: (typeName: string) => void) {
    this._extensionUri = extensionUri;
    this._onShowTypeDetail = onShowTypeDetail;
  }

  setClient(client: HugrClient | null): void {
    this._client = client;
    this._query = '';
    this._kindFilter = '';
    this._semanticSearch = false;
    this._page = 0;
    this._totalCount = 0;
    this._results = [];
    this._loading = false;
    this._semanticAvailable = true;
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
        case 'semantic':
          this._semanticSearch = !!msg.enabled;
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
      if (this._semanticSearch && this._semanticAvailable && this._query.trim()) {
        await this._semanticSearchQuery();
      } else {
        await this._normalSearch();
      }
    } catch {
      this._results = [];
      this._totalCount = 0;
    }

    if (version !== this._searchVersion) return;

    this._loading = false;
    this._postMessage({
      command: 'results',
      results: this._results.map(r => ({
        name: r.name || '',
        kind: r.kind || '',
        kindIcon: kindIconSvg(r.kind || ''),
        description: r.description || '',
        hugrType: r.hugr_type || '',
        hugrTypeLabel: r.hugr_type ? hugrTypeLabel(r.hugr_type) : '',
        hugrTypeColor: r.hugr_type ? hugrTypeColor(r.hugr_type) : '',
        module: r.module || '',
        fieldCount: r.fields_aggregation?._rows_count ?? '',
      })),
      totalCount: this._totalCount,
      page: this._page,
      pageSize: PAGE_SIZE,
    });
  }

  private _buildIlikePattern(raw: string): string {
    const escaped = raw.replace(/"/g, '\\"');
    if (raw.includes('*')) {
      return escaped.replace(/\*/g, '%');
    }
    return `${escaped}%`;
  }

  private async _normalSearch(): Promise<void> {
    if (!this._client) return;

    const filterParts: string[] = [];
    if (this._query.trim()) {
      const pattern = this._buildIlikePattern(this._query.trim());
      filterParts.push(`name: { ilike: "${pattern}" }`);
    }
    if (this._kindFilter) {
      filterParts.push(`kind: { eq: "${this._kindFilter}" }`);
    }

    const filterClause = filterParts.length > 0
      ? `filter: { ${filterParts.join(', ')} }`
      : '';

    const offset = this._page * PAGE_SIZE;

    const query = `{
  core {
    catalog {
      types(
        ${filterClause}
        order_by: [{field: "name", direction: ASC}]
        limit: ${PAGE_SIZE}
        offset: ${offset}
      ) {
        name kind description hugr_type module catalog
        fields_aggregation { _rows_count }
      }
      types_aggregation(
        ${filterClause}
      ) {
        _rows_count
      }
    }
  }
}`;

    const resp = await this._client.query(query);
    this._results = resp.data?.core?.catalog?.types ?? [];
    this._totalCount = resp.data?.core?.catalog?.types_aggregation?._rows_count ?? 0;
  }

  private async _semanticSearchQuery(): Promise<void> {
    if (!this._client) return;

    const escaped = this._query.replace(/"/g, '\\"');
    const offset = this._page * PAGE_SIZE;

    const filterParts: string[] = [];
    if (this._kindFilter) {
      filterParts.push(`kind: {eq: "${this._kindFilter}"}`);
    }
    const filterClause = filterParts.length > 0
      ? `filter: {${filterParts.join(', ')}}`
      : '';

    const query = `{
  core {
    catalog {
      types(
        ${filterClause}
        order_by: [{field: "_distance_to_query", direction: ASC}]
        limit: ${PAGE_SIZE}
        offset: ${offset}
      ) {
        name kind description hugr_type catalog module
        fields_aggregation { _rows_count }
        _distance_to_query(query: "${escaped}")
      }
    }
  }
}`;

    try {
      const resp = await this._client.query(query);
      if (resp.errors?.length) {
        this._semanticAvailable = false;
        this._semanticSearch = false;
        this._postMessage({ command: 'semanticUnavailable' });
        await this._normalSearch();
        return;
      }
      this._results = resp.data?.core?.catalog?.types ?? [];
      this._totalCount = this._results.length < PAGE_SIZE
        ? offset + this._results.length
        : offset + this._results.length + 1;
    } catch {
      this._semanticAvailable = false;
      this._semanticSearch = false;
      this._postMessage({ command: 'semanticUnavailable' });
      await this._normalSearch();
    }
  }

  // -------------------------------------------------------------------------
  // Webview communication
  // -------------------------------------------------------------------------

  private _postMessage(msg: any): void {
    this._view?.webview.postMessage(msg);
  }

  private _updateWebview(): void {
    if (!this._view) return;
    this._view.webview.html = this._getHtml();
  }

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
      <label><input type="checkbox" id="semanticCheck" ${this._semanticSearch ? 'checked' : ''} ${!this._semanticAvailable ? 'disabled' : ''}/> Semantic</label>
    </div>
  </div>
  <div id="results" class="results">
    <div class="status">${this._client ? 'Type to search' : 'No connection'}</div>
  </div>
  <div id="pagination" class="pagination" style="display:none"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('searchInput');
    const kindFilter = document.getElementById('kindFilter');
    const semanticCheck = document.getElementById('semanticCheck');
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

    semanticCheck.addEventListener('change', () => {
      vscode.postMessage({ command: 'semantic', enabled: semanticCheck.checked });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.command === 'loading') {
        resultsDiv.innerHTML = '<div class="status">Loading...</div>';
        paginationDiv.style.display = 'none';
      }

      if (msg.command === 'results') {
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
            + (r.fieldCount !== '' ? '<span class="result-fields">' + r.fieldCount + ' fields</span>' : '')
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

      if (msg.command === 'semanticUnavailable') {
        semanticCheck.checked = false;
        semanticCheck.disabled = true;
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
