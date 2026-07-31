/**
 * Types catalog search section.
 *
 * A searchable, paginated table of the GraphQL types the connected engine
 * serves — the generated surface included, which is what makes it useful:
 * filters, aggregations and mutation inputs are most of what a schema is made
 * of, and they are exactly the names that turn up in an error message.
 *
 * The listing comes from standard introspection (`__schema.types`, with hugr's
 * `hugr_type` / `module` / `catalog` extensions) and is cached per connection,
 * then filtered and paged in the browser. It used to be a server-side query
 * over `core.catalog.types`; that view was part of the compiled-schema storage
 * and went with it — the schema is generated on read now, so there is no table
 * of generated types left to page through.
 *
 * Semantic search went the same way. The vector index covers the LOGICAL model
 * (modules, data objects, functions, fields), never the generated types, so
 * ranking types by meaning is not something the engine can do. Searching the
 * logical model by meaning is `_search`, and belongs in its own section.
 */
import { HugrClient } from '../hugrClient';
import { escapeHtml } from '../utils';
import { kindIcon, hugrTypeIcon } from './icons';
import { showDetailModal } from './detailModal';
import { createGrid, GridApi, GridOptions, ModuleRegistry, AllCommunityModule } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

const PAGE_SIZE = 15;

interface TypeResult {
  name: string;
  kind: string;
  description?: string;
  hugr_type?: string;
  module?: string;
  catalog?: string;
}

export class TypesSearchSection {
  private _container: HTMLElement;
  private _onNavigate: (typeName: string) => void;
  private _client: HugrClient | null = null;

  // State
  private _query = '';
  private _kindFilter = '';
  private _page = 0;
  private _totalCount = 0;
  private _results: TypeResult[] = [];
  private _loading = false;
  private _error: string | null = null;
  // The connection's whole type list, fetched once. ~3k types on a large
  // deployment: half a megabyte, and then every keystroke is local.
  private _allTypes: TypeResult[] | null = null;

  // Debounce & race guard
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _searchVersion = 0;

  // Persistent DOM references
  private _searchInput: HTMLInputElement | null = null;
  private _kindSelect: HTMLSelectElement | null = null;
  private _resultsContainer: HTMLElement | null = null;
  private _gridApi: GridApi | null = null;

  constructor(container: HTMLElement, onNavigate: (typeName: string) => void) {
    this._container = container;
    this._onNavigate = onNavigate;
    this._render();
  }

  /**
   * Set the HugrClient instance and reset state.
   */
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
    this._render();
    if (client) {
      this._search();
    }
  }

  /**
   * Set search text programmatically (for cross-reference navigation).
   */
  setSearchQuery(query: string): void {
    this._query = query;
    this._page = 0;
    if (this._searchInput) {
      this._searchInput.value = query;
    }
    this._search();
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /**
   * Full render — builds the persistent filters row and results container.
   * Called once on construction and when the client changes.
   */
  private _render(): void {
    // Destroy previous grid
    if (this._gridApi) {
      this._gridApi.destroy();
      this._gridApi = null;
    }

    const container = this._container;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'hugr-types-search';

    // --- Filters row (persistent, not rebuilt on search) ---
    const filters = document.createElement('div');
    filters.className = 'hugr-types-filters';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'hugr-types-search-input';
    searchInput.placeholder = 'Search types... (use * for wildcard)';
    searchInput.value = this._query;
    searchInput.addEventListener('input', () => {
      this._query = searchInput.value;
      this._page = 0;
      this._debouncedSearch();
    });
    this._searchInput = searchInput;

    const kindSelect = document.createElement('select');
    kindSelect.className = 'hugr-types-filter-select';
    kindSelect.title = 'Kind';
    const kindOptions: Array<[string, string]> = [
      ['', 'All kinds'],
      ['OBJECT', 'Object'],
      ['INPUT_OBJECT', 'Input'],
      ['ENUM', 'Enum'],
      ['SCALAR', 'Scalar'],
      ['INTERFACE', 'Interface'],
      ['UNION', 'Union'],
    ];
    for (const [value, label] of kindOptions) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === this._kindFilter) {
        opt.selected = true;
      }
      kindSelect.appendChild(opt);
    }
    kindSelect.addEventListener('change', () => {
      this._kindFilter = kindSelect.value;
      this._page = 0;
      this._search();
    });
    this._kindSelect = kindSelect;

    filters.appendChild(searchInput);
    filters.appendChild(kindSelect);
    wrapper.appendChild(filters);

    // --- Results container (updated independently) ---
    const resultsContainer = document.createElement('div');
    resultsContainer.className = 'hugr-types-results';
    this._resultsContainer = resultsContainer;
    wrapper.appendChild(resultsContainer);

    container.appendChild(wrapper);

    // Render initial results content
    this._renderResults();
  }

  /**
   * Update only the results area (grid + pagination) without touching the
   * filters row. This preserves focus on the search input during searches.
   */
  private _renderResults(): void {
    const resultsContainer = this._resultsContainer;
    if (!resultsContainer) {
      return;
    }

    // Destroy previous grid
    if (this._gridApi) {
      this._gridApi.destroy();
      this._gridApi = null;
    }
    resultsContainer.innerHTML = '';

    if (this._loading) {
      const status = document.createElement('div');
      status.className = 'hugr-types-status';
      status.textContent = 'Loading...';
      resultsContainer.appendChild(status);
      return;
    }

    if (this._error) {
      const status = document.createElement('div');
      status.className = 'hugr-types-status';
      status.textContent = this._error;
      resultsContainer.appendChild(status);
      return;
    }

    if (this._results.length === 0) {
      const status = document.createElement('div');
      status.className = 'hugr-types-status';
      status.textContent = this._client ? 'No results' : 'No connection';
      resultsContainer.appendChild(status);
      return;
    }

    // --- AG Grid ---
    const rowData = this._results.map((type) => {
      let iconHtml = kindIcon(type.kind || '');
      if (type.hugr_type) {
        iconHtml += hugrTypeIcon(type.hugr_type);
      }
      return {
        iconHtml,
        name: type.name || '',
        module: type.module || '',
        catalog: type.catalog || '',
        description: type.description || '',
        _typeName: type.name,
      };
    });

    const gridDiv = document.createElement('div');
    gridDiv.className = 'ag-theme-alpine hugr-types-grid';
    gridDiv.style.width = '100%';
    resultsContainer.appendChild(gridDiv);

    const columnDefs: any[] = [
      {
        field: 'iconHtml',
        headerName: '',
        width: 50,
        sortable: false,
        cellRenderer: (params: any) => {
          const el = document.createElement('span');
          el.innerHTML = params.value || '';
          return el;
        },
      },
      { field: 'name', headerName: 'Name', flex: 1, minWidth: 120, sortable: true },
      { field: 'module', headerName: 'Module', flex: 1, minWidth: 100, sortable: true },
      // Was a field COUNT, from an aggregation over the compiled-schema view.
      // Standard introspection carries no counts, and selecting every type's
      // fields to count them client-side more than doubles the payload for a
      // number; the source is the more useful column anyway.
      { field: 'catalog', headerName: 'Source', width: 110, sortable: true },
      {
        field: 'description',
        headerName: 'Description',
        flex: 2,
        minWidth: 150,
        sortable: true,
        cellStyle: {
          'white-space': 'nowrap',
          'overflow': 'hidden',
          'text-overflow': 'ellipsis',
        },
        tooltipField: 'description',
      },
    ];

    const gridOptions: GridOptions = {
      columnDefs,
      rowData,
      domLayout: 'autoHeight',
      rowHeight: 36,
      tooltipShowDelay: 300,
      suppressCellFocus: true,
      onRowClicked: (event: any) => {
        const typeName = event.data?._typeName;
        if (this._client && typeName) {
          showDetailModal(this._client, typeName, this._onNavigate);
        }
      },
      getRowStyle: () => ({ cursor: 'pointer' }),
    };

    this._gridApi = createGrid(gridDiv, gridOptions);

    // --- Pagination ---
    if (this._totalCount > 0) {
      const pagination = document.createElement('div');
      pagination.className = 'hugr-types-pagination';

      const start = this._page * PAGE_SIZE + 1;
      const end = Math.min((this._page + 1) * PAGE_SIZE, this._totalCount);
      const info = document.createElement('span');
      info.textContent = `Showing ${start}-${end} of ${this._totalCount}`;
      pagination.appendChild(info);

      const buttons = document.createElement('div');

      const prevBtn = document.createElement('button');
      prevBtn.className = 'hugr-types-page-btn';
      prevBtn.textContent = 'Prev';
      prevBtn.disabled = this._page === 0;
      prevBtn.addEventListener('click', () => {
        if (this._page > 0) {
          this._goToPage(this._page - 1);
        }
      });

      const nextBtn = document.createElement('button');
      nextBtn.className = 'hugr-types-page-btn';
      nextBtn.textContent = 'Next';
      nextBtn.disabled = end >= this._totalCount;
      nextBtn.addEventListener('click', () => {
        if (end < this._totalCount) {
          this._goToPage(this._page + 1);
        }
      });

      buttons.appendChild(prevBtn);
      buttons.appendChild(nextBtn);
      pagination.appendChild(buttons);
      resultsContainer.appendChild(pagination);
    }
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  private _debouncedSearch(): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._search();
    }, 300);
  }

  private async _search(): Promise<void> {
    if (!this._client) {
      return;
    }

    const version = ++this._searchVersion;
    this._loading = this._allTypes === null;
    if (this._loading) {
      this._renderResults();
    }

    try {
      await this._ensureTypes();
      this._error = null;
      this._applyFilter();
    } catch (err) {
      console.error('Types search error:', err);
      this._error = err instanceof Error ? err.message : String(err);
      this._results = [];
      this._totalCount = 0;
    }

    // Discard stale results if a newer search was started
    if (version !== this._searchVersion) {
      return;
    }

    this._loading = false;
    this._renderResults();
  }

  /**
   * Fetch the connection's type list once and keep it.
   *
   * Standard introspection has no filter, no ordering and no pagination, so
   * the choice is one payload per connection or one per keystroke; the list
   * only changes when a data source is loaded or unloaded, which is what
   * reconnecting is for. Descriptions are included — they are what the
   * description column and the tooltip show — and they are most of the size.
   */
  private async _ensureTypes(): Promise<void> {
    if (this._allTypes !== null || !this._client) {
      return;
    }
    const resp = await this._client.query(`{
  __schema {
    types { name kind description hugr_type module catalog }
  }
}`);
    if (resp.errors && resp.errors.length > 0) {
      throw new Error(resp.errors.map((e: any) => e.message).join('; '));
    }
    const types: TypeResult[] = resp.data?.__schema?.types ?? [];
    // Introspection's own types are not part of anyone's schema.
    this._allTypes = types
      .filter(t => t.name && !t.name.startsWith('__'))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Narrow the cached list and cut the requested page out of it.
   *
   * The matching rule is the one the server-side ilike used to implement, kept
   * so muscle memory survives the move: bare text is a PREFIX match, and a `*`
   * anywhere makes the whole pattern a wildcard match. Both are
   * case-insensitive.
   */
  private _applyFilter(): void {
    const all = this._allTypes ?? [];
    const query = this._query.trim();
    const matches = this._matcher(query);

    const filtered = all.filter(t => {
      if (this._kindFilter && t.kind !== this._kindFilter) {
        return false;
      }
      return matches(t.name);
    });

    this._totalCount = filtered.length;
    const start = this._page * PAGE_SIZE;
    if (start >= filtered.length && this._page > 0) {
      // The filter narrowed past the current page — go back to the first one
      // rather than showing an empty grid under a "showing 46-60 of 12".
      this._page = 0;
      this._results = filtered.slice(0, PAGE_SIZE);
      return;
    }
    this._results = filtered.slice(start, start + PAGE_SIZE);
  }

  private _matcher(query: string): (name: string) => boolean {
    if (!query) {
      return () => true;
    }
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

  /**
   * Paging is local, so it never re-queries.
   */
  private _goToPage(page: number): void {
    this._page = page;
    this._applyFilter();
    this._renderResults();
  }
}
