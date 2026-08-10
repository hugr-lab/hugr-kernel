/**
 * Catalog tree section — hugr's LOGICAL model, lazily loaded.
 *
 * The Schema tab shows the served GraphQL surface: hundreds of generated
 * filters, aggregations and mutation inputs around the handful of things a
 * user actually came to look at. This tab shows the model those were generated
 * FROM — the module tree, the data objects with their relations, the callable
 * functions, the sources they came from, and the SDL-defined type definitions
 * (`_types`: source and system scopes) — through the `_catalog` meta queries,
 * which the engine resolves on the metadata path and filters per role.
 * Generated types are deliberately absent: on a 200k-object model they are the
 * reason `__schema.types` never returns.
 *
 * Every level is one query for one node, issued when the node is opened —
 * including the roots: nothing at all is fetched until a group is expanded.
 * The meta queries have a depth budget, so asking for the whole tree at once
 * is both slower and liable to be truncated; asking per node never is.
 *
 * Searching the model is the separate Search tab (`_search`), which ranks
 * over this same model and navigates into the same detail views.
 */

import { HugrClient } from '../hugrClient';
import { kindIcon, hugrTypeIcon } from './icons';
import type { CatalogDetailTarget } from './detailModal';

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

/**
 * What a row opens on click: a catalog entity's logical view, or — for rows
 * that merely name a GraphQL type (fields, args) — the introspection view.
 */
export type CatalogOpenTarget = { view: 'type'; name: string } | CatalogDetailTarget;

export type CatalogNodeKind =
  | 'group'
  | 'dataSource'
  | 'module'
  | 'dataObject'
  | 'function'
  | 'field'
  | 'relation'
  | 'query'
  | 'arg'
  | 'subquery'
  | 'type';

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
  /** The catalog view this row opens; takes precedence over `typeName`. */
  open?: CatalogOpenTarget;
  /** Icon selector for `type` rows: the GraphQL kind ('OBJECT', 'ENUM', …). */
  iconHint?: string;
  /** Last children fetch failed — the next expand retries instead of caching. */
  loadFailed?: boolean;
  expandable: boolean;
  expanded: boolean;
  children: CatalogTreeNode[] | null;
  loading: boolean;
  depth: number;
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
    args { name description type { name kind ofType { name kind ofType { name kind } } } }
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

// How a data object's GraphQL fields map back onto the MODEL. The generated
// type carries much more than the object: relation navigation fields and
// their aggregation companions (the Relations rows already say that),
// extra-field sugar (_x_part, _geom_measurement), and subquery entry points.
// The tree shows the model: own fields, subquery capabilities, relations.
const SUBQUERY_HUGR_TYPES = new Set(['join', 'function', 'spatial', 'jq', 'h3_data', 'h3_aggregate']);
const HIDDEN_FIELD_HUGR_TYPES = new Set(['select', 'select_one', 'aggregate', 'bucket_agg', 'extra_field']);

// _QueryType (lowercased) → the hugr icon vocabulary. A query row must not
// wear the same scalar circle a field does.
const QUERY_ICON_HINTS: Record<string, string> = {
  select: 'select',
  select_one: 'select_one',
  aggregation: 'aggregate',
  bucket_aggregation: 'bucket_agg',
};

// The SDL-defined type definitions of the model — ~100 rows per scope, where
// the generated surface would be hundreds of thousands.
const TYPES_SCOPE_QUERY = `query($s: _TypeScope!) {
  _types(scope: $s) { name kind description hugr_type module }
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
  private _onShowDetail: (target: CatalogOpenTarget) => void;
  private _client: HugrClient | null = null;
  private _roots: CatalogTreeNode[] = [];
  private _error: string | null = null;
  /** The tree body — the part a toggle redraws. */
  private _body: HTMLElement | null = null;

  constructor(container: HTMLElement, onShowDetail: (target: CatalogOpenTarget) => void) {
    this._container = container;
    this._onShowDetail = onShowDetail;
  }

  setClient(client: HugrClient | null): void {
    this._client = client;
    this._roots = [];
    this._error = null;
    this._render();
    if (client) {
      void this._load();
    }
  }

  refresh(): void {
    if (this._client) {
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
      const probe = await this._client.query('{ m: __type(name: "_Module") { name } }');
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
    // Everything is collapsed and empty until clicked — on a 300-module
    // deployment even the root module listing is a query worth deferring.
    this._roots = [
      {
        id: nextId(),
        kind: 'group',
        label: 'Modules',
        expandable: true,
        expanded: false,
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
      // The SDL-defined type definitions. Two scopes, both lazy — each is one
      // ~100-row metadata query, nothing like the generated surface.
      {
        id: nextId(),
        kind: 'group',
        label: 'Model Types',
        expandable: true,
        expanded: false,
        children: null,
        loading: false,
        depth: 0,
      },
      {
        id: nextId(),
        kind: 'group',
        label: 'System Types',
        expandable: true,
        expanded: false,
        children: null,
        loading: false,
        depth: 0,
      },
    ];
    this._render();
  }

  private async _loadChildren(node: CatalogTreeNode): Promise<void> {
    if (!this._client || node.children !== null) {
      return;
    }
    node.loading = true;
    this._renderBody();
    try {
      node.children = await this._fetchChildren(node);
      node.loadFailed = false;
    } catch (err) {
      // Shown but not CACHED: collapse and re-expand retries the fetch.
      node.loadFailed = true;
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
        open: { view: 'dataSource' as const, name: s.name },
        expandable: false,
        expanded: false,
        children: null,
        loading: false,
        depth,
      }));
    }

    if (node.kind === 'group' && (node.label === 'Model Types' || node.label === 'System Types')) {
      const scope = node.label === 'Model Types' ? 'SOURCE' : 'SYSTEM';
      const resp = await client.query(TYPES_SCOPE_QUERY, { s: scope });
      this._throwOnErrors(resp);
      const types: any[] = (resp.data?._types ?? [])
        .filter((t: any) => t.name && !t.name.startsWith('__'))
        .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
      return types.map(t => ({
        id: nextId(),
        kind: 'type' as const,
        label: t.name,
        detail: [t.kind ? String(t.kind).toLowerCase() : '', t.module ? `in ${t.module}` : '']
          .filter(Boolean)
          .join('  '),
        description: t.description || '',
        typeName: t.name,
        iconHint: t.kind || undefined,
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
          open: { view: 'dataObject', name: o.name },
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
          open: { view: 'function', name: f.name, module: f.moduleName ?? node.moduleName ?? '' },
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
        const qt = (q.type || '').toLowerCase();
        out.push({
          id: nextId(),
          kind: 'query',
          label: q.name,
          detail: qt,
          iconHint: QUERY_ICON_HINTS[qt],
          expandable: false,
          expanded: false,
          children: null,
          loading: false,
          depth,
        });
      }
      // Parameterized-view arguments; null when the object takes none.
      for (const a of obj.args ?? []) {
        out.push({
          id: nextId(),
          kind: 'arg',
          label: a.name,
          detail: typeLabel(a.type),
          description: a.description || '',
          typeName: namedType(a.type),
          expandable: false,
          expanded: false,
          children: null,
          loading: false,
          depth,
        });
      }
      const subqueries: CatalogTreeNode[] = [];
      for (const f of obj.fields ?? []) {
        const ht = f.hugr_type || '';
        if (HIDDEN_FIELD_HUGR_TYPES.has(ht)) {
          continue;
        }
        if (SUBQUERY_HUGR_TYPES.has(ht)) {
          subqueries.push({
            id: nextId(),
            kind: 'subquery',
            label: f.name,
            detail: ht,
            description: f.description || '',
            typeName: namedType(f.type),
            iconHint: ht,
            expandable: false,
            expanded: false,
            children: null,
            loading: false,
            depth,
          });
          continue;
        }
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
      out.push(...subqueries);
      for (const r of obj.relations ?? []) {
        const far = r.dataObject?.name;
        out.push({
          id: nextId(),
          kind: 'relation',
          label: r.fieldName || r.name,
          detail: `${(r.kind || '').toLowerCase()} → ${far ?? '?'}`,
          description: r.description || '',
          open: far ? { view: 'dataObject', name: far } : undefined,
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

  /** Rebuild the section. Called when the CONNECTION changes. */
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
    } else if (node.open) {
      label.style.cursor = 'pointer';
      label.addEventListener('click', () => this._onShowDetail(node.open!));
    } else if (node.typeName) {
      label.style.cursor = 'pointer';
      label.addEventListener('click', () =>
        this._onShowDetail({ view: 'type', name: node.typeName! })
      );
    }
    row.appendChild(label);

    // Expansion owns the label click on expandable rows (data objects,
    // functions), so their catalog view hangs off an explicit affordance.
    if (node.expandable && node.open) {
      const info = document.createElement('span');
      info.textContent = 'ⓘ';
      info.title = 'Details';
      info.style.cssText =
        'flex:none;cursor:pointer;font-size:11px;color:var(--jp-ui-font-color2, #888);';
      info.addEventListener('click', e => {
        e.stopPropagation();
        this._onShowDetail(node.open!);
      });
      row.appendChild(info);
    }

    // A module reloads in place — a 300-module tree must not be torn down to
    // refresh one branch.
    if (node.kind === 'module' || node.kind === 'group') {
      const reload = document.createElement('span');
      reload.textContent = '↻';
      reload.title = 'Reload';
      reload.style.cssText =
        'flex:none;cursor:pointer;font-size:11px;color:var(--jp-ui-font-color2, #888);';
      reload.addEventListener('click', e => {
        e.stopPropagation();
        node.children = null;
        if (node.expanded) {
          void this._loadChildren(node);
        } else {
          this._renderBody();
        }
      });
      row.appendChild(reload);
    }

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
      case 'type':
        return kindIcon(node.iconHint || 'SCALAR');
      case 'subquery':
        return hugrTypeIcon(node.iconHint || 'join');
      case 'query':
        return hugrTypeIcon(node.iconHint || 'select');
      default:
        return kindIcon('SCALAR');
    }
  }

  private async _toggle(node: CatalogTreeNode): Promise<void> {
    if (!node.expandable) {
      return;
    }
    node.expanded = !node.expanded;
    if (node.expanded && (node.children === null || node.loadFailed)) {
      node.loadFailed = false;
      node.children = null;
      await this._loadChildren(node);
      return;
    }
    this._renderBody();
  }
}
