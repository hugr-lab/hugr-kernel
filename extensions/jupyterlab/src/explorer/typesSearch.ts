/**
 * Types catalog search section (T012 + T013).
 *
 * Provides a searchable, paginated AG Grid table of GraphQL types from the
 * Hugr catalog with optional semantic (vector) search support.
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
  fields_aggregation?: { _rows_count: number };
  _distance_to_query?: number;
}

export class TypesSearchSection {
  private _container: HTMLElement;
  private _onNavigate: (typeName: string) => void;
  private _client: HugrClient | null = null;

  // State
  private _query = '';
  private _kindFilter = '';
  private _semanticSearch = false;
  private _page = 0;
  private _totalCount = 0;
  private _results: TypeResult[] = [];
  private _loading = false;
  private _semanticAvailable = true;

  // Debounce & race guard
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _searchVersion = 0;

  // Persistent DOM references
  private _searchInput: HTMLInputElement | null = null;
  private _kindSelect: HTMLSelectElement | null = null;
  private _semanticCheck: HTMLInputElement | null = null;
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
    this._semanticSearch = false;
    this._page = 0;
    this._totalCount = 0;
    this._results = [];
    this._loading = false;
    this._semanticAvailable = true;
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

    const semanticLabel = document.createElement('label');
    semanticLabel.className = 'hugr-types-semantic-toggle';
    const semanticCheck = document.createElement('input');
    semanticCheck.type = 'checkbox';
    semanticCheck.checked = this._semanticSearch;
    semanticCheck.addEventListener('change', () => {
      this._semanticSearch = semanticCheck.checked;
      this._page = 0;
      this._search();
    });
    semanticLabel.appendChild(semanticCheck);
    semanticLabel.appendChild(document.createTextNode(' Semantic'));
    this._semanticCheck = semanticCheck;

    filters.appendChild(searchInput);
    filters.appendChild(kindSelect);
    filters.appendChild(semanticLabel);
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
        fields: type.fields_aggregation?._rows_count ?? '',
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
      { field: 'fields', headerName: 'Fields', width: 70, sortable: true },
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
          this._page--;
          this._search();
        }
      });

      const nextBtn = document.createElement('button');
      nextBtn.className = 'hugr-types-page-btn';
      nextBtn.textContent = 'Next';
      nextBtn.disabled = end >= this._totalCount;
      nextBtn.addEventListener('click', () => {
        if (end < this._totalCount) {
          this._page++;
          this._search();
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
    this._loading = true;
    this._renderResults();

    try {
      if (this._semanticSearch && this._semanticAvailable && this._query.trim()) {
        await this._semanticSearchQuery();
      } else {
        await this._normalSearch();
      }
    } catch (err) {
      console.error('Types search error:', err);
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
   * Build ilike pattern from user query:
   * - If user typed `*`, replace `*` with `%` (user controls wildcards)
   * - Otherwise append `%` for prefix match (e.g. "type" → "type%")
   */
  private _buildIlikePattern(raw: string): string {
    const escaped = raw.replace(/"/g, '\\"');
    if (raw.includes('*')) {
      return escaped.replace(/\*/g, '%');
    }
    return `${escaped}%`;
  }

  private async _normalSearch(): Promise<void> {
    if (!this._client) {
      return;
    }

    // Build filter object dynamically
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
    this._results = resp.data?.core?.catalog?.types || [];
    this._totalCount = resp.data?.core?.catalog?.types_aggregation?._rows_count ?? 0;
  }

  private async _semanticSearchQuery(): Promise<void> {
    if (!this._client) {
      return;
    }

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

      if (resp.errors && resp.errors.length > 0) {
        // Semantic search not available — fall back
        this._semanticAvailable = false;
        this._semanticSearch = false;
        await this._normalSearch();
        return;
      }

      this._results = resp.data?.core?.catalog?.types || [];
      // Semantic search does not provide aggregation; estimate from results
      this._totalCount = this._results.length < PAGE_SIZE
        ? offset + this._results.length
        : offset + this._results.length + 1;
    } catch {
      // Semantic search failed — fall back
      this._semanticAvailable = false;
      this._semanticSearch = false;
      await this._normalSearch();
    }
  }
}
