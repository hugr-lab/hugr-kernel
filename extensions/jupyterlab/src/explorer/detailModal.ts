/**
 * Detail modal for displaying GraphQL type and directive information.
 *
 * Uses introspection queries (__type) with Hugr extensions (hugr_type,
 * catalog, module) for type details. Uses AG Grid for fields tables.
 */
import { HugrClient } from '../hugrClient';
import { escapeHtml } from '../utils';
import { kindIcon, hugrTypeIcon } from './icons';
import { createGrid, GridApi, GridOptions, ModuleRegistry, AllCommunityModule } from 'ag-grid-community';

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

  const header = createHeader(escapeHtml(typeName), overlay);
  const body = document.createElement('div');
  body.className = 'hugr-detail-modal-body';
  body.textContent = 'Loading...';

  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Wire up type-link clicks via event delegation on the body
  if (onNavigate) {
    body.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('hugr-type-link')) {
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
