/**
 * Detail modals for GraphQL types, directives — and catalog entities.
 *
 * Two families share the modal chrome:
 * - GraphQL views: a type via `__type` introspection (with Hugr extensions),
 *   a directive via `__schema.directives`. The SERVED surface.
 * - Catalog views: a data object, function, module or data source via the
 *   `_catalog` meta queries. The LOGICAL model that surface was generated
 *   from — what a table actually is, not the type soup around it.
 *
 * A catalog link REPLACES the modal (a modal has no history); the GraphQL
 * view stays one link away ("Open GraphQL type"). Uses AG Grid for fields
 * tables. Ported to VS Code as detailPanel.ts — keep the two in step.
 */
import { HugrClient } from '../hugrClient';
import { escapeHtml } from '../utils';
import { kindIcon, hugrTypeIcon } from './icons';
import {
  createGrid,
  GridApi,
  GridOptions,
  ModuleRegistry,
  AllCommunityModule,
} from 'ag-grid-community';

// AG Grid v33 renders NOTHING without registered modules. This file owns
// every grid in the detail modals, so the registration lives here — it used
// to ride along in typesSearch.ts, and vanished with it.
ModuleRegistry.registerModules([AllCommunityModule]);

// ---------------------------------------------------------------------------
// Introspection query with Hugr extensions
// ---------------------------------------------------------------------------

const INTROSPECTION_TYPE_QUERY = (typeName: string): string => `{
  __type(name: ${JSON.stringify(typeName)}) {
    name kind description hugr_type catalog module
    fields {
      name description hugr_type catalog
      type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
      args {
        name description defaultValue
        type { name kind ofType { name kind ofType { name kind } } }
      }
    }
    inputFields {
      name description defaultValue
      type { name kind ofType { name kind ofType { name kind } } }
    }
    enumValues { name description }
    interfaces { name }
    possibleTypes { name }
  }
}`;

// ---------------------------------------------------------------------------
// Directive query
// ---------------------------------------------------------------------------

const DIRECTIVES_QUERY = `{
  __schema {
    directives {
      name description isRepeatable
      locations
      args { name description type { name kind ofType { name kind } } defaultValue }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function removeOverlay(overlay: HTMLElement): void {
  // Destroy any AG Grid instances inside before removing
  overlay.querySelectorAll('.ag-theme-alpine').forEach(el => {
    const api = (el as any).__agGridApi;
    if (api) {
      api.destroy();
    }
  });
  if (overlay.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
}

function createOverlay(): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.className = 'hugr-detail-modal-overlay';
  return overlay;
}

function createModal(): HTMLDivElement {
  const modal = document.createElement('div');
  modal.className = 'hugr-detail-modal';
  return modal;
}

function createHeader(titleHtml: string, overlay: HTMLElement): HTMLDivElement {
  const header = document.createElement('div');
  header.className = 'hugr-detail-modal-header';

  const title = document.createElement('div');
  title.className = 'hugr-detail-modal-title';
  title.innerHTML = titleHtml;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'hugr-dlg-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', () => removeOverlay(overlay));

  header.appendChild(title);
  header.appendChild(closeBtn);
  return header;
}

function renderTypeName(
  typeName: string,
  onNavigate?: (name: string) => void
): string {
  const escaped = escapeHtml(typeName);
  if (onNavigate) {
    // Strip [], ! from type name for navigation (e.g. "[aw_Person]" → "aw_Person")
    const baseName = escapeHtml(typeName.replace(/[\[\]!]/g, ''));
    return `<span class="hugr-type-link" data-type-name="${baseName}">${escaped}</span>`;
  }
  return escaped;
}

function resolveIntrospectionTypeName(
  typeRef: { name?: string; kind?: string; ofType?: any } | null
): string {
  if (!typeRef) return '';
  if (typeRef.kind === 'NON_NULL') {
    return resolveIntrospectionTypeName(typeRef.ofType) + '!';
  }
  if (typeRef.kind === 'LIST') {
    return '[' + resolveIntrospectionTypeName(typeRef.ofType) + ']';
  }
  return typeRef.name || '';
}

// ---------------------------------------------------------------------------
// AG Grid cell renderer for type links
// ---------------------------------------------------------------------------

function typeLinkCellRenderer(params: any): HTMLElement {
  const span = document.createElement('span');
  if (!params.value) return span;
  span.innerHTML = params.value;
  return span;
}

// ---------------------------------------------------------------------------
// Create AG Grid for introspection fields
// ---------------------------------------------------------------------------

function createIntrospectionFieldsGrid(
  container: HTMLElement,
  fields: any[],
  onNavigate?: (name: string) => void
): GridApi {
  const rowData = fields.map((f, i) => {
    const typeName = resolveIntrospectionTypeName(f.type);
    const args: any[] = f.args || [];
    return {
      ordinal: i + 1,
      name: f.name || '',
      argsCount: args.length,
      type: typeName,
      typeHtml: typeName ? renderTypeName(typeName, onNavigate) : '',
      hugrType: f.hugr_type || '',
      catalog: f.catalog != null ? String(f.catalog) : '',
      description: f.description || '',
      defaultValue: f.defaultValue ?? '',
      _args: args,
    };
  });

  const columnDefs: any[] = [
    {
      field: 'ordinal',
      headerName: '#',
      width: 40,
      sortable: true,
      cellStyle: { 'font-size': '10px', 'color': '#999' },
    },
    {
      field: 'name',
      headerName: 'Name',
      flex: 1,
      minWidth: 140,
      sortable: true,
      autoHeight: true,
      cellRenderer: (params: any) => {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'line-height:1.3;padding:2px 0;';

        // Main name line
        const nameSpan = document.createElement('div');
        nameSpan.style.fontWeight = '500';
        nameSpan.textContent = params.value;
        wrapper.appendChild(nameSpan);

        // Sub-info line: hugr_type, catalog, args count
        const subParts: string[] = [];
        if (params.data.hugrType) {
          subParts.push(`${hugrTypeIcon(params.data.hugrType)} ${escapeHtml(params.data.hugrType)}`);
        }
        if (params.data.catalog) {
          subParts.push(`catalog: ${escapeHtml(params.data.catalog)}`);
        }
        if (params.data.argsCount > 0) {
          subParts.push(`${params.data.argsCount} args`);
        }
        if (subParts.length > 0) {
          const sub = document.createElement('div');
          sub.style.cssText = 'font-size:10px;color:#888;margin-top:1px;';
          sub.innerHTML = subParts.join(' &middot; ');
          wrapper.appendChild(sub);
        }

        return wrapper;
      },
    },
    {
      field: 'type',
      headerName: 'Type',
      flex: 1,
      minWidth: 100,
      sortable: true,
      cellRenderer: (params: any) => {
        const el = document.createElement('span');
        el.innerHTML = params.data.typeHtml;
        return el;
      },
    },
  ];

  // For input fields, show default value column
  if (fields.some((f) => f.defaultValue != null)) {
    columnDefs.push({
      field: 'defaultValue',
      headerName: 'Default',
      width: 100,
    });
  }

  columnDefs.push({
    field: 'description',
    headerName: 'Description',
    flex: 2,
    minWidth: 150,
    sortable: true,
    autoHeight: true,
    cellStyle: { 'white-space': 'normal', 'line-height': '1.4' },
  });

  const gridDiv = document.createElement('div');
  gridDiv.className = 'ag-theme-alpine hugr-detail-grid';
  const gridHeight = Math.min(400, 40 + rowData.length * 36);
  gridDiv.style.height = `${gridHeight}px`;
  gridDiv.style.width = '100%';
  container.appendChild(gridDiv);

  const gridOptions: GridOptions = {
    columnDefs,
    rowData,
    domLayout: rowData.length <= 10 ? 'autoHeight' : 'normal',
    suppressCellFocus: true,
    masterDetail: true,
    detailRowAutoHeight: true,
    isRowMaster: (data: any) => data._args && data._args.length > 0,
    detailCellRendererParams: {
      detailGridOptions: {
        columnDefs: [
          { field: 'name', headerName: 'Arg Name', flex: 1, minWidth: 100 },
          {
            field: 'type',
            headerName: 'Type',
            flex: 1,
            minWidth: 100,
            cellRenderer: typeLinkCellRenderer,
          },
          { field: 'defaultValue', headerName: 'Default', width: 100 },
          { field: 'description', headerName: 'Description', flex: 2, minWidth: 120 },
        ],
        domLayout: 'autoHeight',
        suppressCellFocus: true,
      },
      getDetailRowData: (params: any) => {
        const args = params.data._args || [];
        const argRows = args.map((a: any) => {
          const typeName = resolveIntrospectionTypeName(a.type);
          return {
            name: a.name || '',
            type: renderTypeName(typeName, onNavigate),
            defaultValue: a.defaultValue ?? '',
            description: a.description || '',
          };
        });
        params.successCallback(argRows);
      },
    },
  };

  const api = createGrid(gridDiv, gridOptions);
  (gridDiv as any).__agGridApi = api;

  if (onNavigate) {
    gridDiv.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('hugr-type-link')) {
        const name = target.getAttribute('data-type-name');
        if (name) onNavigate(name);
      }
    });
  }

  return api;
}

// ---------------------------------------------------------------------------
// showDetailModal
// ---------------------------------------------------------------------------

export function showDetailModal(
  client: HugrClient,
  typeName: string,
  onNavigate?: (typeName: string) => void
): void {
  const overlay = createOverlay();
  const modal = createModal();

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      removeOverlay(overlay);
    }
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      document.removeEventListener('keydown', onKeyDown);
      removeOverlay(overlay);
    }
  };
  document.addEventListener('keydown', onKeyDown);

  const header = createHeader(escapeHtml(typeName), overlay);
  const body = document.createElement('div');
  body.className = 'hugr-detail-modal-body';
  body.textContent = 'Loading...';

  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Wire up type-link clicks via event delegation on the body. Links inside
  // AG grids are handled by the grid's own listener — acting on the bubbled
  // click here would fire onNavigate twice.
  if (onNavigate) {
    body.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (
        target.classList.contains('hugr-type-link') &&
        !target.closest('.hugr-detail-grid')
      ) {
        const name = target.getAttribute('data-type-name');
        if (name) {
          onNavigate(name);
        }
      }
    });
  }

  // Fetch data and render into body
  populateTypeDetail(client, typeName, body, onNavigate).catch((err) => {
    body.innerHTML = `<p>Error loading type detail: ${escapeHtml(String(err))}</p>`;
  });
}

async function populateTypeDetail(
  client: HugrClient,
  typeName: string,
  body: HTMLElement,
  onNavigate?: (name: string) => void
): Promise<void> {
  const resp = await client.query(INTROSPECTION_TYPE_QUERY(typeName));
  const typeData = resp.data?.__type;

  if (typeData) {
    renderIntrospectionTypeInto(body, typeData, onNavigate);
    return;
  }

  body.innerHTML = `<p>Type "${escapeHtml(typeName)}" not found.</p>`;
}

function renderEnumList(enumValues: any[]): string {
  let html = '<ul class="hugr-detail-enum-list">';
  for (const ev of enumValues) {
    const name = escapeHtml(ev.name || '');
    const desc = ev.description ? ` — ${escapeHtml(ev.description)}` : '';
    html += `<li><strong>${name}</strong>${desc}</li>`;
  }
  html += '</ul>';
  return html;
}

// ---------------------------------------------------------------------------
// Render introspection fallback type into container
// ---------------------------------------------------------------------------

function renderIntrospectionTypeInto(
  container: HTMLElement,
  type: any,
  onNavigate?: (name: string) => void
): void {
  container.innerHTML = '';

  // Metadata badges
  const badges: string[] = [];
  if (type.kind) {
    badges.push(`<span class="hugr-detail-badge">${kindIcon(type.kind)} ${escapeHtml(type.kind)}</span>`);
  }
  if (type.hugr_type) {
    badges.push(
      `<span class="hugr-detail-badge">${hugrTypeIcon(type.hugr_type)} ${escapeHtml(type.hugr_type)}</span>`
    );
  }
  if (type.catalog != null) {
    badges.push(
      `<span class="hugr-detail-badge">catalog: ${escapeHtml(String(type.catalog))}</span>`
    );
  }
  if (type.module) {
    badges.push(
      `<span class="hugr-detail-badge">module: ${escapeHtml(type.module)}</span>`
    );
  }
  if (badges.length > 0) {
    const metaDiv = document.createElement('div');
    metaDiv.className = 'hugr-detail-meta';
    metaDiv.innerHTML = badges.join('');
    container.appendChild(metaDiv);
  }

  // Description
  if (type.description) {
    const descDiv = document.createElement('div');
    descDiv.className = 'hugr-detail-desc';
    descDiv.textContent = type.description;
    container.appendChild(descDiv);
  }

  // Interfaces
  const interfaces: any[] = type.interfaces || [];
  if (interfaces.length > 0) {
    const title = document.createElement('div');
    title.className = 'hugr-detail-section-title';
    title.textContent = `Implements (${interfaces.length})`;
    container.appendChild(title);
    const listDiv = document.createElement('div');
    listDiv.className = 'hugr-detail-interfaces';
    listDiv.innerHTML = interfaces.map((i: any) =>
      `<span class="hugr-type-link" data-type-name="${escapeHtml(i.name)}">${escapeHtml(i.name)}</span>`
    ).join(', ');
    container.appendChild(listDiv);
  }

  // Possible types (for UNION / INTERFACE)
  const possibleTypes: any[] = type.possibleTypes || [];
  if (possibleTypes.length > 0) {
    const title = document.createElement('div');
    title.className = 'hugr-detail-section-title';
    title.textContent = `Possible Types (${possibleTypes.length})`;
    container.appendChild(title);
    const listDiv = document.createElement('div');
    listDiv.className = 'hugr-detail-interfaces';
    listDiv.innerHTML = possibleTypes.map((t: any) =>
      `<span class="hugr-type-link" data-type-name="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>`
    ).join(', ');
    container.appendChild(listDiv);
  }

  // Fields (OBJECT types)
  const fields: any[] = type.fields || [];
  if (fields.length > 0) {
    const title = document.createElement('div');
    title.className = 'hugr-detail-section-title';
    title.textContent = `Fields (${fields.length})`;
    container.appendChild(title);
    createIntrospectionFieldsGrid(container, fields, onNavigate);
  }

  // Input fields (INPUT_OBJECT types)
  const inputFields: any[] = type.inputFields || [];
  if (inputFields.length > 0) {
    const title = document.createElement('div');
    title.className = 'hugr-detail-section-title';
    title.textContent = `Fields (${inputFields.length})`;
    container.appendChild(title);
    createIntrospectionFieldsGrid(container, inputFields, onNavigate);
  }

  // Enum values
  const enumValues: any[] = type.enumValues || [];
  if (enumValues.length > 0) {
    const title = document.createElement('div');
    title.className = 'hugr-detail-section-title';
    title.textContent = `Values (${enumValues.length})`;
    container.appendChild(title);
    const listDiv = document.createElement('div');
    listDiv.innerHTML = renderEnumList(enumValues);
    container.appendChild(listDiv);
  }
}

// ---------------------------------------------------------------------------
// showDirectiveDetail
// ---------------------------------------------------------------------------

export function showDirectiveDetail(
  client: HugrClient,
  directiveName: string
): void {
  const overlay = createOverlay();
  const modal = createModal();

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      removeOverlay(overlay);
    }
  });

  const displayName = directiveName.startsWith('@')
    ? directiveName
    : `@${directiveName}`;

  const header = createHeader(escapeHtml(displayName), overlay);
  const body = document.createElement('div');
  body.className = 'hugr-detail-modal-body';
  body.textContent = 'Loading...';

  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const lookupName = directiveName.startsWith('@')
    ? directiveName.slice(1)
    : directiveName;

  client.query(DIRECTIVES_QUERY).then((resp) => {
    const directives: any[] = resp.data?.__schema?.directives || [];
    const directive = directives.find((d: any) => d.name === lookupName);

    if (!directive) {
      body.innerHTML = `<p>Directive "${escapeHtml(displayName)}" not found.</p>`;
      return;
    }

    renderDirectiveInto(body, directive);
  }).catch((err) => {
    body.innerHTML = `<p>Error loading directive detail: ${escapeHtml(String(err))}</p>`;
  });
}

function renderDirectiveInto(container: HTMLElement, directive: any): void {
  container.innerHTML = '';

  // Metadata badges
  const badges: string[] = [];
  if (directive.isRepeatable) {
    badges.push('<span class="hugr-detail-badge">repeatable</span>');
  }
  if (badges.length > 0) {
    const metaDiv = document.createElement('div');
    metaDiv.className = 'hugr-detail-meta';
    metaDiv.innerHTML = badges.join('');
    container.appendChild(metaDiv);
  }

  // Description
  if (directive.description) {
    const descDiv = document.createElement('div');
    descDiv.className = 'hugr-detail-desc';
    descDiv.textContent = directive.description;
    container.appendChild(descDiv);
  }

  // Locations
  const locations: string[] = directive.locations || [];
  if (locations.length > 0) {
    const title = document.createElement('div');
    title.className = 'hugr-detail-section-title';
    title.textContent = `Locations (${locations.length})`;
    container.appendChild(title);
    const ul = document.createElement('ul');
    ul.className = 'hugr-detail-enum-list';
    for (const loc of locations) {
      const li = document.createElement('li');
      li.textContent = loc;
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }

  // Arguments AG Grid
  const args: any[] = directive.args || [];
  if (args.length > 0) {
    const title = document.createElement('div');
    title.className = 'hugr-detail-section-title';
    title.textContent = `Arguments (${args.length})`;
    container.appendChild(title);

    const rowData = args.map((arg: any) => {
      const typeName = resolveIntrospectionTypeName(arg.type);
      return {
        name: arg.name || '',
        type: typeName,
        defaultValue: arg.defaultValue ?? '',
        description: arg.description || '',
      };
    });

    const gridDiv = document.createElement('div');
    gridDiv.className = 'ag-theme-alpine hugr-detail-grid';
    gridDiv.style.height = `${Math.min(300, 40 + rowData.length * 36)}px`;
    gridDiv.style.width = '100%';
    container.appendChild(gridDiv);

    const gridOptions: GridOptions = {
      columnDefs: [
        { field: 'name', headerName: 'Name', flex: 1, minWidth: 100, sortable: true },
        { field: 'type', headerName: 'Type', flex: 1, minWidth: 100, sortable: true },
        { field: 'defaultValue', headerName: 'Default', width: 100 },
        { field: 'description', headerName: 'Description', flex: 2, minWidth: 150, sortable: true },
      ],
      rowData,
      domLayout: rowData.length <= 10 ? 'autoHeight' : 'normal',
      suppressCellFocus: true,
    };

    const api = createGrid(gridDiv, gridOptions);
    (gridDiv as any).__agGridApi = api;
  }
}

// ---------------------------------------------------------------------------
// Catalog detail — the logical model behind the generated types
// ---------------------------------------------------------------------------

/**
 * A logical-model entity, addressed the way the catalog addresses it — a
 * function needs its module because function names are only unique within one.
 */
export type CatalogDetailTarget =
  | { view: 'dataObject'; name: string }
  | { view: 'function'; name: string; module: string }
  | { view: 'module'; name: string }
  | { view: 'dataSource'; name: string };

const TYPE_REF = 'name kind ofType { name kind ofType { name kind ofType { name kind } } }';

const DATA_OBJECT_DETAIL_QUERY = `query($n: String!) {
  _dataObject(name: $n) {
    name type description longDescription moduleName dataSourceName dataSources primaryKey
    properties { isCube isM2M isHypertable softDelete hasVectors }
    args { name description defaultValue type { ${TYPE_REF} } }
    queries { name type rootTypeName args { name description defaultValue type { ${TYPE_REF} } } }
    fields { name description hugr_type type { ${TYPE_REF} } }
    relations {
      name kind direction fieldName description sourceKeys destinationKeys dataSource
      dataObject { name }
      through { name }
    }
  }
}`;

const FUNCTION_DETAIL_QUERY = `query($m: String!, $n: String!) {
  _function(module: $m, name: $n) {
    name type description longDescription moduleName dataSourceName isTable
    args { name description defaultValue type { ${TYPE_REF} } }
    returns { ${TYPE_REF} }
  }
}`;

const MODULE_DETAIL_QUERY = `query($m: String!) {
  _module(name: $m) {
    name description longDescription
    modules { name description }
    dataObjects { name type description }
    functions { name type description moduleName }
  }
}`;

const DATA_SOURCE_DETAIL_QUERY = `query($n: String!) {
  _dataSource(name: $n) {
    name engine description longDescription readOnly asModule isExtension modules
  }
}`;

const CAT_TABLE = 'width:100%;border-collapse:collapse;font-size:12px;margin:4px 0 8px;';
const CAT_TH =
  'text-align:left;padding:4px 6px;border-bottom:1px solid var(--jp-border-color1,#ccc);font-size:11px;';
const CAT_TD =
  'padding:4px 6px;border-bottom:1px solid var(--jp-border-color2,#eee);vertical-align:top;';

/** A link that replaces the modal with another catalog entity's view. */
function catLink(target: CatalogDetailTarget, display?: string): string {
  return (
    `<span class="hugr-type-link hugr-cat-link" data-target="${escapeHtml(JSON.stringify(target))}">` +
    `${escapeHtml(display ?? target.name)}</span>`
  );
}

function catBadge(html: string): string {
  return `<span class="hugr-detail-badge">${html}</span>`;
}

function catSectionTitle(text: string): string {
  return `<div class="hugr-detail-section-title">${escapeHtml(text)}</div>`;
}

/** description, then longDescription when it adds something. */
function catDescHtml(entity: { description?: string; longDescription?: string }): string {
  let html = '';
  if (entity.description) {
    html += `<div class="hugr-detail-desc">${escapeHtml(entity.description)}</div>`;
  }
  if (entity.longDescription && entity.longDescription !== entity.description) {
    html += `<div class="hugr-detail-desc">${escapeHtml(entity.longDescription)}</div>`;
  }
  return html;
}

function catThrowOnErrors(resp: any): void {
  if (resp?.errors?.length) {
    throw new Error(resp.errors.map((e: any) => e.message).join('; '));
  }
}

export function showCatalogDetailModal(
  client: HugrClient,
  target: CatalogDetailTarget,
  onNavigate?: (typeName: string) => void
): void {
  const overlay = createOverlay();
  const modal = createModal();

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      removeOverlay(overlay);
    }
  });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      document.removeEventListener('keydown', onKeyDown);
      removeOverlay(overlay);
    }
  };
  document.addEventListener('keydown', onKeyDown);

  const title = target.view === 'module' ? target.name || 'modules' : target.name;
  const header = createHeader(escapeHtml(title), overlay);
  const body = document.createElement('div');
  body.className = 'hugr-detail-modal-body';
  body.textContent = 'Loading...';
  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Link delegation. A catalog link replaces this modal; "Open GraphQL type"
  // swaps to the introspection modal; a plain type link keeps its panel
  // behavior — the Types tab via onNavigate.
  body.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const cat = el.closest('.hugr-cat-link') as HTMLElement | null;
    if (cat) {
      try {
        const next = JSON.parse(cat.getAttribute('data-target') || '') as CatalogDetailTarget;
        document.removeEventListener('keydown', onKeyDown);
        removeOverlay(overlay);
        showCatalogDetailModal(client, next, onNavigate);
      } catch {
        /* malformed target — ignore the click */
      }
      return;
    }
    const gql = el.closest('.hugr-gql-link') as HTMLElement | null;
    if (gql) {
      const name = gql.getAttribute('data-type-name');
      if (name) {
        document.removeEventListener('keydown', onKeyDown);
        removeOverlay(overlay);
        showDetailModal(client, name, onNavigate);
      }
      return;
    }
    // Type links inside AG grids are handled by the grid's own listener —
    // acting on the bubbled click here would fire onNavigate twice.
    if (
      onNavigate &&
      el.classList.contains('hugr-type-link') &&
      !el.closest('.hugr-detail-grid')
    ) {
      const name = el.getAttribute('data-type-name');
      if (name) {
        onNavigate(name);
      }
    }
  });

  populateCatalogDetail(client, target, body, onNavigate).catch((err) => {
    body.innerHTML = `<p>Error loading details: ${escapeHtml(String(err))}</p>`;
  });
}

async function populateCatalogDetail(
  client: HugrClient,
  target: CatalogDetailTarget,
  body: HTMLElement,
  onNavigate?: (name: string) => void
): Promise<void> {
  switch (target.view) {
    case 'dataObject': {
      const resp = await client.query(DATA_OBJECT_DETAIL_QUERY, { n: target.name });
      catThrowOnErrors(resp);
      const obj = resp.data?._dataObject;
      if (!obj) {
        body.innerHTML = `<p>Data object "${escapeHtml(target.name)}" not found.</p>`;
        return;
      }
      renderDataObjectInto(body, obj, onNavigate);
      return;
    }
    case 'function': {
      const resp = await client.query(FUNCTION_DETAIL_QUERY, {
        m: target.module,
        n: target.name,
      });
      catThrowOnErrors(resp);
      const fn = resp.data?._function;
      if (!fn) {
        body.innerHTML = `<p>Function "${escapeHtml(target.name)}" not found.</p>`;
        return;
      }
      renderFunctionInto(body, fn, onNavigate);
      return;
    }
    case 'module': {
      const resp = await client.query(MODULE_DETAIL_QUERY, { m: target.name });
      catThrowOnErrors(resp);
      const mod = resp.data?._module;
      if (!mod) {
        body.innerHTML = `<p>Module "${escapeHtml(target.name)}" not found.</p>`;
        return;
      }
      renderModuleInto(body, mod);
      return;
    }
    case 'dataSource': {
      const resp = await client.query(DATA_SOURCE_DETAIL_QUERY, { n: target.name });
      catThrowOnErrors(resp);
      const src = resp.data?._dataSource;
      if (!src) {
        body.innerHTML = `<p>Data source "${escapeHtml(target.name)}" not found.</p>`;
        return;
      }
      renderDataSourceInto(body, src);
      return;
    }
  }
}

function appendMeta(container: HTMLElement, badges: string[]): void {
  if (!badges.length) {
    return;
  }
  const meta = document.createElement('div');
  meta.className = 'hugr-detail-meta';
  meta.innerHTML = badges.join('');
  container.appendChild(meta);
}

function renderDataObjectInto(
  container: HTMLElement,
  obj: any,
  onNavigate?: (name: string) => void
): void {
  container.innerHTML = '';

  const isView = obj.type === 'VIEW';
  const badges: string[] = [
    catBadge(`${hugrTypeIcon(isView ? 'view' : 'table')} ${isView ? 'View' : 'Table'}`),
  ];
  const props = obj.properties ?? {};
  if (props.isCube) badges.push(catBadge('cube'));
  if (props.isM2M) badges.push(catBadge('m2m'));
  if (props.isHypertable) badges.push(catBadge('hypertable'));
  if (props.softDelete) badges.push(catBadge('soft delete'));
  if (props.hasVectors) badges.push(catBadge('vectors'));
  if (obj.moduleName) {
    badges.push(catBadge(`module: ${catLink({ view: 'module', name: obj.moduleName }, obj.moduleName)}`));
  }
  if (obj.dataSourceName) {
    badges.push(
      catBadge(`source: ${catLink({ view: 'dataSource', name: obj.dataSourceName }, obj.dataSourceName)}`)
    );
  }
  const extraSources = (obj.dataSources ?? []).filter(
    (s: string) => s && s !== obj.dataSourceName
  );
  if (extraSources.length) {
    badges.push(catBadge(`extended by: ${escapeHtml(extraSources.join(', '))}`));
  }
  appendMeta(container, badges);

  container.insertAdjacentHTML('beforeend', catDescHtml(obj));

  // Parameterized-view arguments; null when the object takes none.
  const args: any[] = obj.args ?? [];
  if (args.length) {
    container.insertAdjacentHTML('beforeend', catSectionTitle(`Arguments (${args.length})`));
    createIntrospectionFieldsGrid(container, args, onNavigate);
  }

  const queries: any[] = obj.queries ?? [];
  if (queries.length) {
    container.insertAdjacentHTML('beforeend', catSectionTitle(`Queries (${queries.length})`));
    let html = `<table style="${CAT_TABLE}"><thead><tr>` +
      `<th style="${CAT_TH}">Name</th><th style="${CAT_TH}">Kind</th><th style="${CAT_TH}">Arguments</th>` +
      '</tr></thead><tbody>';
    for (const q of queries) {
      const qargs = (q.args ?? [])
        .map((a: any) => {
          const t = resolveIntrospectionTypeName(a.type);
          return `${escapeHtml(a.name)}: ${renderTypeName(t, onNavigate)}`;
        })
        .join(', ');
      html += `<tr><td style="${CAT_TD}"><strong>${escapeHtml(q.name)}</strong></td>` +
        `<td style="${CAT_TD}">${escapeHtml((q.type || '').toLowerCase().replace(/_/g, ' '))}</td>` +
        `<td style="${CAT_TD}">${qargs}</td></tr>`;
    }
    html += '</tbody></table>';
    container.insertAdjacentHTML('beforeend', html);
  }

  // The generated type carries much more than the model: relation navigation
  // fields and aggregation companions (the Relations section already says
  // that), extra-field sugar, and subquery entry points. Show the model's own
  // fields, and the subquery capabilities separately.
  const SUBQUERY_TYPES = new Set(['join', 'function', 'spatial', 'jq', 'h3_data', 'h3_aggregate']);
  const HIDDEN_TYPES = new Set(['select', 'select_one', 'aggregate', 'bucket_agg', 'extra_field']);
  const pk: string[] = obj.primaryKey ?? [];
  const allFields: any[] = obj.fields ?? [];
  const fields = allFields.filter(
    (f: any) => !HIDDEN_TYPES.has(f.hugr_type || '') && !SUBQUERY_TYPES.has(f.hugr_type || '')
  );
  const subqueryFields = allFields.filter((f: any) => SUBQUERY_TYPES.has(f.hugr_type || ''));
  if (fields.length) {
    container.insertAdjacentHTML('beforeend', catSectionTitle(`Fields (${fields.length})`));
    const marked = fields.map((f: any) =>
      pk.includes(f.name) ? { ...f, name: `${f.name} 🔑` } : f
    );
    createIntrospectionFieldsGrid(container, marked, onNavigate);
  }

  if (subqueryFields.length) {
    container.insertAdjacentHTML('beforeend', catSectionTitle(`Subqueries (${subqueryFields.length})`));
    let html = `<table style="${CAT_TABLE}"><thead><tr>` +
      `<th style="${CAT_TH}">Name</th><th style="${CAT_TH}">Kind</th>` +
      `<th style="${CAT_TH}">Type</th><th style="${CAT_TH}">Description</th>` +
      '</tr></thead><tbody>';
    for (const f of subqueryFields) {
      const t = resolveIntrospectionTypeName(f.type);
      html += '<tr>' +
        `<td style="${CAT_TD}"><strong>${escapeHtml(f.name)}</strong></td>` +
        `<td style="${CAT_TD}">${escapeHtml(f.hugr_type || '')}</td>` +
        `<td style="${CAT_TD}">${renderTypeName(t, onNavigate)}</td>` +
        `<td style="${CAT_TD}">${f.description ? escapeHtml(f.description) : ''}</td>` +
        '</tr>';
    }
    html += '</tbody></table>';
    container.insertAdjacentHTML('beforeend', html);
  }

  const relations: any[] = obj.relations ?? [];
  if (relations.length) {
    container.insertAdjacentHTML('beforeend', catSectionTitle(`Relations (${relations.length})`));
    let html = `<table style="${CAT_TABLE}"><thead><tr>` +
      `<th style="${CAT_TH}">Field</th><th style="${CAT_TH}">Kind</th><th style="${CAT_TH}">Target</th>` +
      `<th style="${CAT_TH}">Keys</th><th style="${CAT_TH}">Description</th>` +
      '</tr></thead><tbody>';
    for (const r of relations) {
      const far = r.dataObject?.name;
      const kindBits = [
        (r.kind || '').toLowerCase(),
        r.direction === 'BACK' ? 'back' : '',
        r.through?.name ? `via ${r.through.name}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const src = (r.sourceKeys ?? []).join(', ');
      const dst = (r.destinationKeys ?? []).join(', ');
      const keys = src || dst ? `${src} → ${dst}` : '';
      html += '<tr>' +
        `<td style="${CAT_TD}"><strong>${escapeHtml(r.fieldName || r.name)}</strong></td>` +
        `<td style="${CAT_TD}">${escapeHtml(kindBits)}</td>` +
        `<td style="${CAT_TD}">${far ? catLink({ view: 'dataObject', name: far }) : ''}</td>` +
        `<td style="${CAT_TD}">${escapeHtml(keys)}</td>` +
        `<td style="${CAT_TD}">${r.description ? escapeHtml(r.description) : ''}</td>` +
        '</tr>';
    }
    html += '</tbody></table>';
    container.insertAdjacentHTML('beforeend', html);
  }

  container.insertAdjacentHTML(
    'beforeend',
    `<p><span class="hugr-type-link hugr-gql-link" data-type-name="${escapeHtml(obj.name)}">` +
      `Open GraphQL type ${escapeHtml(obj.name)} →</span></p>`
  );
}

function renderFunctionInto(
  container: HTMLElement,
  fn: any,
  onNavigate?: (name: string) => void
): void {
  container.innerHTML = '';

  const typeLabel =
    (fn.type || 'FUNCTION') === 'FUNCTION'
      ? 'Function'
      : (fn.type || '').charAt(0) + (fn.type || '').slice(1).toLowerCase();
  const badges: string[] = [catBadge(`${hugrTypeIcon('function')} ${escapeHtml(typeLabel)}`)];
  if (fn.isTable) badges.push(catBadge('returns rows'));
  if (fn.moduleName) {
    badges.push(catBadge(`module: ${catLink({ view: 'module', name: fn.moduleName }, fn.moduleName)}`));
  }
  if (fn.dataSourceName) {
    badges.push(
      catBadge(`source: ${catLink({ view: 'dataSource', name: fn.dataSourceName }, fn.dataSourceName)}`)
    );
  }
  appendMeta(container, badges);

  container.insertAdjacentHTML('beforeend', catDescHtml(fn));

  const args: any[] = fn.args ?? [];
  if (args.length) {
    container.insertAdjacentHTML('beforeend', catSectionTitle(`Arguments (${args.length})`));
    createIntrospectionFieldsGrid(container, args, onNavigate);
  }

  if (fn.returns) {
    const t = resolveIntrospectionTypeName(fn.returns);
    container.insertAdjacentHTML('beforeend', catSectionTitle('Returns'));
    container.insertAdjacentHTML(
      'beforeend',
      `<p>${renderTypeName(t, onNavigate)}${fn.isTable ? ' (rows)' : ''}</p>`
    );
  }
}

function renderModuleInto(container: HTMLElement, mod: any): void {
  container.innerHTML = '';

  appendMeta(container, [catBadge(`${hugrTypeIcon('module')} Module`)]);
  container.insertAdjacentHTML('beforeend', catDescHtml(mod));

  const modules: any[] = mod.modules ?? [];
  if (modules.length) {
    container.insertAdjacentHTML('beforeend', catSectionTitle(`Submodules (${modules.length})`));
    let html = `<table style="${CAT_TABLE}"><thead><tr>` +
      `<th style="${CAT_TH}">Name</th><th style="${CAT_TH}">Description</th></tr></thead><tbody>`;
    for (const m of modules) {
      html += `<tr><td style="${CAT_TD}">${catLink({ view: 'module', name: m.name })}</td>` +
        `<td style="${CAT_TD}">${m.description ? escapeHtml(m.description) : ''}</td></tr>`;
    }
    html += '</tbody></table>';
    container.insertAdjacentHTML('beforeend', html);
  }

  const objects: any[] = mod.dataObjects ?? [];
  if (objects.length) {
    container.insertAdjacentHTML('beforeend', catSectionTitle(`Data Objects (${objects.length})`));
    let html = `<table style="${CAT_TABLE}"><thead><tr>` +
      `<th style="${CAT_TH}">Name</th><th style="${CAT_TH}">Kind</th><th style="${CAT_TH}">Description</th>` +
      '</tr></thead><tbody>';
    for (const o of objects) {
      html += `<tr><td style="${CAT_TD}">${catLink({ view: 'dataObject', name: o.name })}</td>` +
        `<td style="${CAT_TD}">${escapeHtml((o.type || '').toLowerCase())}</td>` +
        `<td style="${CAT_TD}">${o.description ? escapeHtml(o.description) : ''}</td></tr>`;
    }
    html += '</tbody></table>';
    container.insertAdjacentHTML('beforeend', html);
  }

  const functions: any[] = mod.functions ?? [];
  if (functions.length) {
    container.insertAdjacentHTML('beforeend', catSectionTitle(`Functions (${functions.length})`));
    let html = `<table style="${CAT_TABLE}"><thead><tr>` +
      `<th style="${CAT_TH}">Name</th><th style="${CAT_TH}">Kind</th><th style="${CAT_TH}">Description</th>` +
      '</tr></thead><tbody>';
    for (const f of functions) {
      html += '<tr><td style="' + CAT_TD + '">' +
        catLink({ view: 'function', name: f.name, module: f.moduleName ?? mod.name ?? '' }) +
        `</td><td style="${CAT_TD}">${escapeHtml((f.type || '').toLowerCase())}</td>` +
        `<td style="${CAT_TD}">${f.description ? escapeHtml(f.description) : ''}</td></tr>`;
    }
    html += '</tbody></table>';
    container.insertAdjacentHTML('beforeend', html);
  }

  if (!modules.length && !objects.length && !functions.length) {
    container.insertAdjacentHTML('beforeend', '<div class="hugr-detail-desc">Empty module.</div>');
  }
}

function renderDataSourceInto(container: HTMLElement, src: any): void {
  container.innerHTML = '';

  const badges: string[] = [catBadge('Data Source')];
  if (src.engine) badges.push(catBadge(escapeHtml(src.engine)));
  if (src.readOnly) badges.push(catBadge('read-only'));
  if (src.asModule) badges.push(catBadge('as module'));
  if (src.isExtension) badges.push(catBadge('extension'));
  appendMeta(container, badges);

  container.insertAdjacentHTML('beforeend', catDescHtml(src));

  const modules = (src.modules ?? []).filter((m: string) => m != null);
  if (modules.length) {
    container.insertAdjacentHTML('beforeend', catSectionTitle(`Modules (${modules.length})`));
    const links = modules
      .map((m: string) => (m === '' ? '<em>(root)</em>' : catLink({ view: 'module', name: m })))
      .join(', ');
    container.insertAdjacentHTML('beforeend', `<div>${links}</div>`);
  }
}
