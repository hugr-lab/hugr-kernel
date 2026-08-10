/**
 * WebviewPanel for detail views in VS Code.
 *
 * Two families of content share the panel and its history:
 *
 * - GraphQL views: a type via `__type` introspection, a directive via
 *   `__schema.directives`. This is the SERVED surface — every generated
 *   filter, aggregation and mutation input.
 * - Catalog views: a data object, function, module or data source via the
 *   `_catalog` meta queries. This is the LOGICAL model the surface was
 *   generated from — what a table actually is (fields, keys, relations,
 *   queries), not the type soup around it.
 *
 * A row in the Catalog tree opens the catalog view; the GraphQL view stays
 * one link away ("Open GraphQL type") for when the generated names are the
 * question. Ported from JupyterLab detailModal.ts — keep the two in step.
 */
import * as vscode from 'vscode';
import { HugrClient } from './hugrClient';
import { kindIconSvg, kindColor, hugrTypeColor, kindLabel, hugrTypeLabel } from './icons';

/**
 * What the panel is showing. `type` is a GraphQL type by name; the rest are
 * logical-model entities, addressed the way the catalog addresses them — a
 * function needs its module because function names are only unique within one.
 */
export type DetailTarget =
  | { view: 'type'; name: string }
  | { view: 'dataObject'; name: string }
  | { view: 'function'; name: string; module: string }
  | { view: 'module'; name: string }
  | { view: 'dataSource'; name: string };

// ---------------------------------------------------------------------------
// Introspection queries
// ---------------------------------------------------------------------------

function typeDetailQuery(typeName: string): string {
  return `{
  __type(name: ${JSON.stringify(typeName)}) {
    name kind description hugr_type catalog module
    fields {
      name description hugr_type catalog
      type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
      args {
        name description defaultValue
        type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
      }
    }
    inputFields {
      name description defaultValue
      type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
    }
    enumValues { name description }
    interfaces { name }
    possibleTypes { name }
  }
}`;
}

const DIRECTIVES_QUERY = `{
  __schema {
    directives {
      name description isRepeatable locations
      args {
        name description defaultValue
        type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Catalog queries — the logical model behind the generated types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Type unwrapping
// ---------------------------------------------------------------------------

function resolveTypeName(typeRef: any): string {
  if (!typeRef) return '';
  if (typeRef.kind === 'NON_NULL') return resolveTypeName(typeRef.ofType) + '!';
  if (typeRef.kind === 'LIST') return '[' + resolveTypeName(typeRef.ofType) + ']';
  return typeRef.name || '';
}

function baseTypeName(typeRef: any): string {
  if (!typeRef) return '';
  if (typeRef.name) return typeRef.name;
  return baseTypeName(typeRef.ofType);
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Detail Panel
// ---------------------------------------------------------------------------

let _panel: vscode.WebviewPanel | null = null;
let _currentClient: HugrClient | null = null;
let _history: DetailTarget[] = [];
let _loadVersion = 0;
/** What the panel is currently showing; null when empty or on a directive. */
let _current: DetailTarget | null = null;

function _sameTarget(a: DetailTarget, b: DetailTarget): boolean {
  return a.view === b.view && a.name === b.name &&
    (a.view !== 'function' || b.view !== 'function' || a.module === b.module);
}

function _targetTitle(t: DetailTarget): string {
  if (t.view === 'module') return t.name || 'modules';
  return t.name;
}

function _ensurePanel(title: string): void {
  if (_panel) return;

  _panel = vscode.window.createWebviewPanel(
    'hugrTypeDetail',
    title,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel.onDidDispose(() => {
    _panel = null;
    _history = [];
    _current = null;
  });

  _panel.webview.onDidReceiveMessage((msg) => {
    if (!_currentClient) return;
    if (msg.command === 'showType' && msg.typeName) {
      showTypeDetail(msg.typeName, _currentClient);
    }
    if (msg.command === 'showCatalog' && msg.target?.view && msg.target?.name != null) {
      showDetail(msg.target as DetailTarget, _currentClient);
    }
    if (msg.command === 'goBack') {
      if (_history.length > 0) {
        const prev = _history.pop()!;
        showDetail(prev, _currentClient, false);
      }
    }
  });
}

export function showDetail(
  target: DetailTarget,
  client: HugrClient,
  addToHistory = true
): void {
  _currentClient = client;
  const title = _targetTitle(target);
  _ensurePanel(title);

  if (addToHistory && _current && !_sameTarget(_current, target)) {
    _history.push(_current);
  }

  _current = target;
  _panel!.title = title;
  _panel!.webview.html = loadingHtml(title, _history.length > 0);

  const version = ++_loadVersion;
  loadDetail(target, client).then(html => {
    if (_panel && version === _loadVersion) {
      _panel.webview.html = html;
    }
  });
}

export function showTypeDetail(
  typeName: string,
  client: HugrClient,
  addToHistory = true
): void {
  showDetail({ view: 'type', name: typeName }, client, addToHistory);
}

export function showDirectiveDetail(
  directiveName: string,
  client: HugrClient
): void {
  _currentClient = client;
  _history = [];
  _current = null;
  const displayName = directiveName.startsWith('@') ? directiveName : `@${directiveName}`;

  _ensurePanel(displayName);

  _panel!.title = displayName;
  _panel!.webview.html = loadingHtml(displayName, false);

  const version = ++_loadVersion;
  loadDirectiveDetail(directiveName, client).then(html => {
    if (_panel && version === _loadVersion) {
      _panel.webview.html = html;
    }
  });
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * A GraphQL error must never read as "not found" — permission denied and an
 * expired token both come back as errors with null data, and telling the
 * user the object does not exist is worse than no answer.
 */
function throwOnErrors(res: any): void {
  if (res?.errors?.length) {
    throw new Error(res.errors.map((e: any) => e.message).join('; '));
  }
}

async function loadDetail(target: DetailTarget, client: HugrClient): Promise<string> {
  try {
    switch (target.view) {
      case 'type':
        return await loadTypeDetail(target.name, client);
      case 'dataObject': {
        const res = await client.query(DATA_OBJECT_DETAIL_QUERY, { n: target.name });
        throwOnErrors(res);
        const obj = res.data?._dataObject;
        if (!obj) return errorHtml(`Data object "${esc(target.name)}" not found.`);
        return renderDataObjectHtml(obj);
      }
      case 'function': {
        const res = await client.query(FUNCTION_DETAIL_QUERY, { m: target.module, n: target.name });
        throwOnErrors(res);
        const fn = res.data?._function;
        if (!fn) return errorHtml(`Function "${esc(target.name)}" not found.`);
        return renderFunctionHtml(fn);
      }
      case 'module': {
        const res = await client.query(MODULE_DETAIL_QUERY, { m: target.name });
        throwOnErrors(res);
        const mod = res.data?._module;
        if (!mod) return errorHtml(`Module "${esc(target.name)}" not found.`);
        return renderModuleHtml(mod);
      }
      case 'dataSource': {
        const res = await client.query(DATA_SOURCE_DETAIL_QUERY, { n: target.name });
        throwOnErrors(res);
        const src = res.data?._dataSource;
        if (!src) return errorHtml(`Data source "${esc(target.name)}" not found.`);
        return renderDataSourceHtml(src);
      }
    }
  } catch (err: any) {
    return errorHtml(`Error loading details: ${esc(String(err?.message ?? err))}`);
  }
}

async function loadTypeDetail(typeName: string, client: HugrClient): Promise<string> {
  try {
    const res = await client.query(typeDetailQuery(typeName));
    const typeData = res.data?.__type;
    if (!typeData) {
      return errorHtml(`Type "${esc(typeName)}" not found.`);
    }
    return renderTypeHtml(typeData);
  } catch (err: any) {
    return errorHtml(`Error loading type: ${esc(String(err?.message ?? err))}`);
  }
}

async function loadDirectiveDetail(directiveName: string, client: HugrClient): Promise<string> {
  const lookupName = directiveName.startsWith('@') ? directiveName.slice(1) : directiveName;

  try {
    const res = await client.query(DIRECTIVES_QUERY);
    const directives: any[] = res.data?.__schema?.directives ?? [];
    const directive = directives.find((d: any) => d.name === lookupName);
    if (!directive) {
      return errorHtml(`Directive "@${esc(lookupName)}" not found.`);
    }
    return renderDirectiveHtml(directive);
  } catch (err: any) {
    return errorHtml(`Error loading directive: ${esc(String(err?.message ?? err))}`);
  }
}

// ---------------------------------------------------------------------------
// HTML rendering — Type
// ---------------------------------------------------------------------------

function renderTypeHtml(type: any): string {
  let body = '';

  // Metadata badges
  const badges: string[] = [];
  if (type.kind) {
    const color = kindColor(type.kind);
    badges.push(`<span class="badge" style="background:${color}22;color:${color}">${kindIconSvg(type.kind)} ${esc(type.kind)}</span>`);
  }
  if (type.hugr_type) {
    const color = hugrTypeColor(type.hugr_type);
    badges.push(`<span class="badge" style="background:${color}22;color:${color}">${esc(hugrTypeLabel(type.hugr_type))}</span>`);
  }
  if (type.catalog != null) {
    badges.push(`<span class="badge">catalog: ${esc(String(type.catalog))}</span>`);
  }
  if (type.module) {
    badges.push(`<span class="badge">module: ${esc(type.module)}</span>`);
  }
  if (badges.length) {
    body += `<div class="meta">${badges.join(' ')}</div>`;
  }

  // Description
  if (type.description) {
    body += `<p class="desc">${esc(type.description)}</p>`;
  }

  // Interfaces
  const interfaces: any[] = type.interfaces ?? [];
  if (interfaces.length) {
    body += `<h3>Implements (${interfaces.length})</h3>`;
    body += `<div class="type-links">${interfaces.map((i: any) => typeLink(i.name)).join(', ')}</div>`;
  }

  // Possible types (UNION/INTERFACE)
  const possibleTypes: any[] = type.possibleTypes ?? [];
  if (possibleTypes.length) {
    body += `<h3>Possible Types (${possibleTypes.length})</h3>`;
    body += `<div class="type-links">${possibleTypes.map((t: any) => typeLink(t.name)).join(', ')}</div>`;
  }

  // Fields (OBJECT)
  const fields: any[] = type.fields ?? [];
  if (fields.length) {
    body += `<h3>Fields (${fields.length})</h3>`;
    body += renderFieldsTable(fields);
  }

  // Input fields (INPUT_OBJECT)
  const inputFields: any[] = type.inputFields ?? [];
  if (inputFields.length) {
    body += `<h3>Fields (${inputFields.length})</h3>`;
    body += renderInputFieldsTable(inputFields);
  }

  // Enum values
  const enumValues: any[] = type.enumValues ?? [];
  if (enumValues.length) {
    body += `<h3>Values (${enumValues.length})</h3>`;
    body += '<ul class="enum-list">';
    for (const ev of enumValues) {
      const desc = ev.description ? ` — ${esc(ev.description)}` : '';
      body += `<li><strong>${esc(ev.name)}</strong>${desc}</li>`;
    }
    body += '</ul>';
  }

  return wrapHtml(esc(type.name), body, _history.length > 0);
}

// ---------------------------------------------------------------------------
// HTML rendering — Catalog (logical model)
// ---------------------------------------------------------------------------

/** A link that navigates the panel to a catalog entity. */
function catalogLink(target: DetailTarget, display?: string): string {
  return `<a href="#" class="cat-link" data-target="${esc(JSON.stringify(target))}">${esc(display ?? target.name)}</a>`;
}

function coloredBadge(label: string, color: string): string {
  return `<span class="badge" style="background:${color}22;color:${color}">${esc(label)}</span>`;
}

function plainBadge(label: string): string {
  return `<span class="badge">${esc(label)}</span>`;
}

/** description, then longDescription when it adds something. */
function descriptionHtml(entity: { description?: string; longDescription?: string }): string {
  let html = '';
  if (entity.description) {
    html += `<p class="desc">${esc(entity.description)}</p>`;
  }
  if (entity.longDescription && entity.longDescription !== entity.description) {
    html += `<p class="desc">${esc(entity.longDescription)}</p>`;
  }
  return html;
}

function renderDataObjectHtml(obj: any): string {
  let body = '';

  const isView = obj.type === 'VIEW';
  const badges: string[] = [
    coloredBadge(isView ? 'View' : 'Table', hugrTypeColor(isView ? 'view' : 'table')),
  ];
  const props = obj.properties ?? {};
  if (props.isCube) badges.push(plainBadge('cube'));
  if (props.isM2M) badges.push(plainBadge('m2m'));
  if (props.isHypertable) badges.push(plainBadge('hypertable'));
  if (props.softDelete) badges.push(plainBadge('soft delete'));
  if (props.hasVectors) badges.push(plainBadge('vectors'));
  if (obj.moduleName) {
    badges.push(`<span class="badge">module: ${catalogLink({ view: 'module', name: obj.moduleName }, obj.moduleName)}</span>`);
  }
  if (obj.dataSourceName) {
    badges.push(`<span class="badge">source: ${catalogLink({ view: 'dataSource', name: obj.dataSourceName }, obj.dataSourceName)}</span>`);
  }
  const extraSources = (obj.dataSources ?? []).filter((s: string) => s && s !== obj.dataSourceName);
  if (extraSources.length) {
    badges.push(plainBadge(`extended by: ${extraSources.join(', ')}`));
  }
  body += `<div class="meta">${badges.join(' ')}</div>`;

  body += descriptionHtml(obj);

  // Parameterized-view arguments; null when the object takes none.
  const args: any[] = obj.args ?? [];
  if (args.length) {
    body += `<h3>Arguments (${args.length})</h3>`;
    body += renderInputFieldsTable(args);
  }

  const queries: any[] = obj.queries ?? [];
  if (queries.length) {
    body += `<h3>Queries (${queries.length})</h3>`;
    body += '<table><thead><tr><th>Name</th><th>Kind</th><th>Arguments</th></tr></thead><tbody>';
    for (const q of queries) {
      const qargs = (q.args ?? [])
        .map((a: any) => {
          const t = resolveTypeName(a.type);
          const base = baseTypeName(a.type);
          return `${esc(a.name)}: ${base ? typeLink(t, base) : esc(t)}`;
        })
        .join(', ');
      body += '<tr>';
      body += `<td><strong>${esc(q.name)}</strong></td>`;
      body += `<td>${esc((q.type || '').toLowerCase().replace(/_/g, ' '))}</td>`;
      body += `<td>${qargs}</td>`;
      body += '</tr>';
    }
    body += '</tbody></table>';
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
    body += `<h3>Fields (${fields.length})</h3>`;
    body += '<table><thead><tr><th>#</th><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>';
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const typeName = resolveTypeName(f.type);
      const base = baseTypeName(f.type);
      const subParts: string[] = [];
      if (pk.includes(f.name)) subParts.push('pk');
      if (f.hugr_type && f.hugr_type !== 'column') subParts.push(esc(hugrTypeLabel(f.hugr_type)));
      const sub = subParts.length ? `<div class="sub">${subParts.join(' · ')}</div>` : '';
      body += '<tr>';
      body += `<td class="ordinal">${i + 1}</td>`;
      body += `<td><strong>${esc(f.name)}</strong>${sub}</td>`;
      body += `<td>${base ? typeLink(typeName, base) : esc(typeName)}</td>`;
      body += `<td>${f.description ? esc(f.description) : ''}</td>`;
      body += '</tr>';
    }
    body += '</tbody></table>';
  }

  if (subqueryFields.length) {
    body += `<h3>Subqueries (${subqueryFields.length})</h3>`;
    body += '<table><thead><tr><th>Name</th><th>Kind</th><th>Type</th><th>Description</th></tr></thead><tbody>';
    for (const f of subqueryFields) {
      const typeName = resolveTypeName(f.type);
      const base = baseTypeName(f.type);
      body += '<tr>';
      body += `<td><strong>${esc(f.name)}</strong></td>`;
      body += `<td>${esc(hugrTypeLabel(f.hugr_type).toLowerCase())}</td>`;
      body += `<td>${base ? typeLink(typeName, base) : esc(typeName)}</td>`;
      body += `<td>${f.description ? esc(f.description) : ''}</td>`;
      body += '</tr>';
    }
    body += '</tbody></table>';
  }

  const relations: any[] = obj.relations ?? [];
  if (relations.length) {
    body += `<h3>Relations (${relations.length})</h3>`;
    body += '<table><thead><tr><th>Field</th><th>Kind</th><th>Target</th><th>Keys</th><th>Description</th></tr></thead><tbody>';
    for (const r of relations) {
      const far = r.dataObject?.name;
      const kindBits = [
        (r.kind || '').toLowerCase(),
        r.direction === 'BACK' ? 'back' : '',
        r.through?.name ? `via ${r.through.name}` : '',
      ].filter(Boolean);
      const src = (r.sourceKeys ?? []).join(', ');
      const dst = (r.destinationKeys ?? []).join(', ');
      const keys = src || dst ? `${src} → ${dst}` : '';
      body += '<tr>';
      body += `<td><strong>${esc(r.fieldName || r.name)}</strong></td>`;
      body += `<td>${esc(kindBits.join(' '))}</td>`;
      body += `<td>${far ? catalogLink({ view: 'dataObject', name: far }) : ''}</td>`;
      body += `<td>${esc(keys)}</td>`;
      body += `<td>${r.description ? esc(r.description) : ''}</td>`;
      body += '</tr>';
    }
    body += '</tbody></table>';
  }

  body += `<p>${typeLink(`Open GraphQL type ${obj.name} →`, obj.name)}</p>`;

  return wrapHtml(esc(obj.name), body, _history.length > 0);
}

function renderFunctionHtml(fn: any): string {
  let body = '';

  const badges: string[] = [
    coloredBadge(
      (fn.type || 'FUNCTION').toLowerCase() === 'function'
        ? 'Function'
        : (fn.type || '').charAt(0) + (fn.type || '').slice(1).toLowerCase(),
      hugrTypeColor('function'),
    ),
  ];
  if (fn.isTable) badges.push(plainBadge('returns rows'));
  if (fn.moduleName) {
    badges.push(`<span class="badge">module: ${catalogLink({ view: 'module', name: fn.moduleName }, fn.moduleName)}</span>`);
  }
  if (fn.dataSourceName) {
    badges.push(`<span class="badge">source: ${catalogLink({ view: 'dataSource', name: fn.dataSourceName }, fn.dataSourceName)}</span>`);
  }
  body += `<div class="meta">${badges.join(' ')}</div>`;

  body += descriptionHtml(fn);

  const args: any[] = fn.args ?? [];
  if (args.length) {
    body += `<h3>Arguments (${args.length})</h3>`;
    body += renderInputFieldsTable(args);
  }

  if (fn.returns) {
    const t = resolveTypeName(fn.returns);
    const base = baseTypeName(fn.returns);
    body += `<h3>Returns</h3>`;
    body += `<p>${base ? typeLink(t, base) : esc(t)}${fn.isTable ? ' (rows)' : ''}</p>`;
  }

  return wrapHtml(esc(fn.name), body, _history.length > 0);
}

function renderModuleHtml(mod: any): string {
  let body = '';

  body += `<div class="meta">${coloredBadge('Module', hugrTypeColor('module'))}</div>`;
  body += descriptionHtml(mod);

  const modules: any[] = mod.modules ?? [];
  if (modules.length) {
    body += `<h3>Submodules (${modules.length})</h3>`;
    body += '<table><thead><tr><th>Name</th><th>Description</th></tr></thead><tbody>';
    for (const m of modules) {
      body += `<tr><td>${catalogLink({ view: 'module', name: m.name })}</td><td>${m.description ? esc(m.description) : ''}</td></tr>`;
    }
    body += '</tbody></table>';
  }

  const objects: any[] = mod.dataObjects ?? [];
  if (objects.length) {
    body += `<h3>Data Objects (${objects.length})</h3>`;
    body += '<table><thead><tr><th>Name</th><th>Kind</th><th>Description</th></tr></thead><tbody>';
    for (const o of objects) {
      body += '<tr>';
      body += `<td>${catalogLink({ view: 'dataObject', name: o.name })}</td>`;
      body += `<td>${esc((o.type || '').toLowerCase())}</td>`;
      body += `<td>${o.description ? esc(o.description) : ''}</td>`;
      body += '</tr>';
    }
    body += '</tbody></table>';
  }

  const functions: any[] = mod.functions ?? [];
  if (functions.length) {
    body += `<h3>Functions (${functions.length})</h3>`;
    body += '<table><thead><tr><th>Name</th><th>Kind</th><th>Description</th></tr></thead><tbody>';
    for (const f of functions) {
      body += '<tr>';
      body += `<td>${catalogLink({ view: 'function', name: f.name, module: f.moduleName ?? mod.name ?? '' })}</td>`;
      body += `<td>${esc((f.type || '').toLowerCase())}</td>`;
      body += `<td>${f.description ? esc(f.description) : ''}</td>`;
      body += '</tr>';
    }
    body += '</tbody></table>';
  }

  if (!modules.length && !objects.length && !functions.length) {
    body += '<p class="desc">Empty module.</p>';
  }

  return wrapHtml(esc(mod.name || 'modules'), body, _history.length > 0);
}

function renderDataSourceHtml(src: any): string {
  let body = '';

  const badges: string[] = [coloredBadge('Data Source', hugrTypeColor('module'))];
  if (src.engine) badges.push(plainBadge(src.engine));
  if (src.readOnly) badges.push(plainBadge('read-only'));
  if (src.asModule) badges.push(plainBadge('as module'));
  if (src.isExtension) badges.push(plainBadge('extension'));
  body += `<div class="meta">${badges.join(' ')}</div>`;

  body += descriptionHtml(src);

  const modules = (src.modules ?? []).filter((m: string) => m != null);
  if (modules.length) {
    body += `<h3>Modules (${modules.length})</h3>`;
    body += `<div class="type-links">${modules
      .map((m: string) => (m === '' ? '<em>(root)</em>' : catalogLink({ view: 'module', name: m })))
      .join(', ')}</div>`;
  }

  return wrapHtml(esc(src.name), body, _history.length > 0);
}

// ---------------------------------------------------------------------------
// HTML rendering — Directive
// ---------------------------------------------------------------------------

function renderDirectiveHtml(directive: any): string {
  let body = '';

  // Badges
  const badges: string[] = [];
  if (directive.isRepeatable) {
    badges.push('<span class="badge">repeatable</span>');
  }
  if (badges.length) {
    body += `<div class="meta">${badges.join(' ')}</div>`;
  }

  // Description
  if (directive.description) {
    body += `<p class="desc">${esc(directive.description)}</p>`;
  }

  // Locations
  const locations: string[] = directive.locations ?? [];
  if (locations.length) {
    body += `<h3>Locations (${locations.length})</h3>`;
    body += '<ul class="enum-list">';
    for (const loc of locations) {
      body += `<li>${esc(loc)}</li>`;
    }
    body += '</ul>';
  }

  // Arguments
  const args: any[] = directive.args ?? [];
  if (args.length) {
    body += `<h3>Arguments (${args.length})</h3>`;
    body += '<table><thead><tr><th>Name</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody>';
    for (const arg of args) {
      const typeName = resolveTypeName(arg.type);
      const base = baseTypeName(arg.type);
      body += '<tr>';
      body += `<td><strong>${esc(arg.name)}</strong></td>`;
      body += `<td>${base ? typeLink(typeName, base) : esc(typeName)}</td>`;
      body += `<td>${arg.defaultValue != null ? esc(String(arg.defaultValue)) : ''}</td>`;
      body += `<td>${arg.description ? esc(arg.description) : ''}</td>`;
      body += '</tr>';
    }
    body += '</tbody></table>';
  }

  return wrapHtml(`@${esc(directive.name)}`, body, _history.length > 0);
}

// ---------------------------------------------------------------------------
// Fields table
// ---------------------------------------------------------------------------

function renderFieldsTable(fields: any[]): string {
  let html = '<table><thead><tr><th>#</th><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>';

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const typeName = resolveTypeName(f.type);
    const base = baseTypeName(f.type);
    const args: any[] = f.args ?? [];
    const subParts: string[] = [];
    if (f.hugr_type) subParts.push(esc(hugrTypeLabel(f.hugr_type)));
    if (f.catalog != null) subParts.push(`catalog: ${esc(String(f.catalog))}`);
    if (args.length) subParts.push(`${args.length} args`);
    const sub = subParts.length ? `<div class="sub">${subParts.join(' · ')}</div>` : '';

    html += '<tr>';
    html += `<td class="ordinal">${i + 1}</td>`;
    html += `<td><strong>${esc(f.name)}</strong>${sub}</td>`;
    html += `<td>${base ? typeLink(typeName, base) : esc(typeName)}</td>`;
    html += `<td>${f.description ? esc(f.description) : ''}</td>`;
    html += '</tr>';

    // Expandable args rows
    if (args.length) {
      html += `<tr class="args-row"><td></td><td colspan="3">`;
      html += '<table class="args-table"><thead><tr><th>Arg</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody>';
      for (const arg of args) {
        const argTypeName = resolveTypeName(arg.type);
        const argBase = baseTypeName(arg.type);
        html += '<tr>';
        html += `<td>${esc(arg.name)}</td>`;
        html += `<td>${argBase ? typeLink(argTypeName, argBase) : esc(argTypeName)}</td>`;
        html += `<td>${arg.defaultValue != null ? esc(String(arg.defaultValue)) : ''}</td>`;
        html += `<td>${arg.description ? esc(arg.description) : ''}</td>`;
        html += '</tr>';
      }
      html += '</tbody></table></td></tr>';
    }
  }

  html += '</tbody></table>';
  return html;
}

function renderInputFieldsTable(fields: any[]): string {
  let html = '<table><thead><tr><th>#</th><th>Name</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody>';

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const typeName = resolveTypeName(f.type);
    const base = baseTypeName(f.type);

    html += '<tr>';
    html += `<td class="ordinal">${i + 1}</td>`;
    html += `<td><strong>${esc(f.name)}</strong></td>`;
    html += `<td>${base ? typeLink(typeName, base) : esc(typeName)}</td>`;
    html += `<td>${f.defaultValue != null ? esc(String(f.defaultValue)) : ''}</td>`;
    html += `<td>${f.description ? esc(f.description) : ''}</td>`;
    html += '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function typeLink(displayName: string, navigateName?: string): string {
  const base = navigateName ?? displayName.replace(/[\[\]!]/g, '');
  return `<a href="#" class="type-link" data-type="${esc(base)}">${esc(displayName)}</a>`;
}

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

function loadingHtml(title: string, hasHistory = false): string {
  return wrapHtml(esc(title), '<p class="loading">Loading...</p>', hasHistory);
}

function errorHtml(message: string): string {
  return wrapHtml('Error', `<p class="error">${message}</p>`, false);
}

function wrapHtml(title: string, body: string, hasHistory = false): string {
  const backBtn = hasHistory
    ? `<a href="#" class="back-btn" id="backBtn">\u2190 Back</a>`
    : '';
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
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
    line-height: 1.5;
  }
  h2 { margin: 0 0 12px; font-size: 1.4em; }
  h3 { margin: 16px 0 8px; font-size: 1.1em; color: var(--vscode-foreground); }
  .header-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .header-row h2 { margin: 0; }
  .back-btn {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 10px; border-radius: 4px; font-size: 11px;
    background: var(--vscode-button-secondaryBackground, #333);
    color: var(--vscode-button-secondaryForeground, #ccc);
    cursor: pointer; text-decoration: none; white-space: nowrap;
  }
  .back-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, #444);
  }
  .meta { margin-bottom: 12px; display: flex; flex-wrap: wrap; gap: 6px; }
  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 4px; font-size: 11px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .badge svg { width: 14px; height: 14px; vertical-align: middle; }
  .desc { margin: 8px 0; color: var(--vscode-descriptionForeground); }
  table {
    width: 100%; border-collapse: collapse; margin: 8px 0;
    font-size: 12px;
  }
  th, td {
    text-align: left; padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
  }
  th {
    background: var(--vscode-editorGroupHeader-tabsBackground);
    font-weight: 600; font-size: 11px;
    color: var(--vscode-foreground);
  }
  .ordinal { width: 30px; color: var(--vscode-descriptionForeground); font-size: 10px; }
  .sub { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .type-link, .cat-link {
    color: var(--vscode-textLink-foreground);
    cursor: pointer; text-decoration: none;
  }
  .type-link:hover, .cat-link:hover { text-decoration: underline; }
  .badge .cat-link { color: inherit; text-decoration: underline dotted; }
  .type-links { display: flex; flex-wrap: wrap; gap: 8px; }
  .enum-list { margin: 4px 0; padding-left: 20px; }
  .enum-list li { margin: 2px 0; }
  .args-row td { padding-top: 0; }
  .args-table {
    width: 100%; margin: 4px 0 8px;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    border-radius: 4px;
  }
  .args-table th { font-size: 10px; }
  .args-table td { font-size: 11px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
  .loading { color: var(--vscode-descriptionForeground); font-style: italic; }
  .error { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
  <div class="header-row">${backBtn}<h2>${title}</h2></div>
  ${body}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.type-link');
      if (link) {
        e.preventDefault();
        const typeName = link.getAttribute('data-type');
        if (typeName) {
          vscode.postMessage({ command: 'showType', typeName });
        }
      }
      const catLink = e.target.closest('.cat-link');
      if (catLink) {
        e.preventDefault();
        try {
          const target = JSON.parse(catLink.getAttribute('data-target'));
          vscode.postMessage({ command: 'showCatalog', target });
        } catch {}
      }
      const backBtn = e.target.closest('.back-btn');
      if (backBtn) {
        e.preventDefault();
        vscode.postMessage({ command: 'goBack' });
      }
    });
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
