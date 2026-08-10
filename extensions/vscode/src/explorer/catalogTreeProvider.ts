/**
 * Catalog Explorer TreeDataProvider for VS Code — hugr's LOGICAL model.
 *
 * The Schema view shows the served GraphQL surface: hundreds of generated
 * filters, aggregations and mutation inputs around the handful of things a
 * user actually came to look at. This view shows the model those were
 * generated FROM — the module tree, the data objects with their relations, the
 * callable functions, the sources they came from, and the SDL-defined type
 * definitions (`_types`: source and system scopes) — through the `_catalog`
 * meta queries, which the engine resolves on the metadata path and filters per
 * role. Generated types are deliberately absent: on a 200k-object model they
 * are the reason `__schema.types` never returns.
 *
 * Every level is one query for one node, issued when the node is opened. The
 * meta queries have a depth budget, so asking for the whole tree at once is
 * both slower and liable to be truncated; asking per node never is.
 *
 * Searching the model is the separate Search view (`_search`), which ranks
 * over this same model and navigates into the same detail views.
 *
 * Ported from JupyterLab catalogTree.ts — keep the two in step.
 */
import * as vscode from 'vscode';
import { HugrClient } from './hugrClient';
import { kindIconPath, hugrTypeIconPath, hugrTypeLabel } from './icons';
import type { DetailTarget } from './detailPanel';

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
  | 'type'
  | 'message';

export interface CatalogTreeNode {
  id: string;
  kind: CatalogNodeKind;
  label: string;
  /** Right-hand annotation: a GraphQL type, a source engine, a relation target. */
  detail?: string;
  description?: string;
  /** The GraphQL type name this row can open a detail view for. */
  typeName?: string;
  /** Dotted module name — a module node's identity, a member's scope. */
  moduleName?: string;
  /**
   * What clicking this row opens in the detail panel. A logical-model row
   * opens its catalog view; rows that only name a GraphQL type (fields, args)
   * fall back to `typeName` and the introspection view.
   */
  open?: DetailTarget;
  /**
   * Icon selector: a dataObject row's hugr type ('table' | 'view'), a type
   * row's GraphQL kind ('OBJECT', 'ENUM', …).
   */
  iconHint?: string;
  expandable: boolean;
  children?: CatalogTreeNode[];
  childrenLoaded: boolean;
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

let _nextId = 0;
function nextId(): string {
  return `ctn-${_nextId++}`;
}

/** Render a possibly-wrapped introspection type as SDL. */
function typeLabel(t: any): string {
  if (!t) return '';
  if (t.name) return t.name;
  const inner = typeLabel(t.ofType);
  if (t.kind === 'NON_NULL') return `${inner}!`;
  if (t.kind === 'LIST') return `[${inner}]`;
  return inner;
}

/** The named type at the bottom of the wrappers — what a detail view opens. */
function namedType(t: any): string | undefined {
  if (!t) return undefined;
  return t.name || namedType(t.ofType);
}

/** The last dotted segment — a module row shows its own name, not its path. */
function leafName(dotted: string): string {
  const i = dotted.lastIndexOf('.');
  return i >= 0 ? dotted.slice(i + 1) : dotted;
}

export class CatalogTreeProvider implements vscode.TreeDataProvider<CatalogTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<CatalogTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _client: HugrClient | null = null;
  private _roots: CatalogTreeNode[] = [];
  private _error: string | null = null;

  setClient(client: HugrClient | null): void {
    this._client = client;
    this._roots = [];
    this._error = null;
    if (client) {
      void this._loadRoots();
    } else {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  refresh(): void {
    if (this._client) {
      this._roots = [];
      this._error = null;
      void this._loadRoots();
    }
  }

  /** Re-query one node's subtree in place; the rest of the tree stands. */
  refreshNode(node: CatalogTreeNode): void {
    node.children = undefined;
    node.childrenLoaded = false;
    this._onDidChangeTreeData.fire(node);
  }

  // -----------------------------------------------------------------------
  // TreeDataProvider
  // -----------------------------------------------------------------------

  getTreeItem(element: CatalogTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.expandable
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    // Nodes get FRESH ids on every reload. Without an explicit id VS Code
    // matches nodes by label and keeps yesterday's expansion state — a
    // connection reload then looks like nothing happened. New ids collapse
    // and reset the tree.
    item.id = element.id;

    if (element.detail) {
      item.description = element.detail;
    }

    const tooltip: string[] = [element.label];
    if (element.detail) tooltip.push(`: ${element.detail}`);
    if (element.description) tooltip.push(`\n${element.description}`);
    item.tooltip = tooltip.join('');

    switch (element.kind) {
      case 'group':
      case 'module':
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        break;
      case 'dataObject':
        item.iconPath = hugrTypeIconPath(element.iconHint ?? 'table');
        break;
      case 'type':
        item.iconPath = kindIconPath(element.iconHint ?? 'SCALAR');
        break;
      case 'subquery':
        item.iconPath = hugrTypeIconPath(element.iconHint ?? 'join');
        break;
      case 'function':
        item.iconPath = new vscode.ThemeIcon('symbol-method');
        break;
      case 'dataSource':
        item.iconPath = new vscode.ThemeIcon('database');
        break;
      case 'relation':
        item.iconPath = new vscode.ThemeIcon('references');
        break;
      case 'query':
        item.iconPath = element.iconHint
          ? hugrTypeIconPath(element.iconHint)
          : new vscode.ThemeIcon('play');
        break;
      case 'message':
        item.iconPath = new vscode.ThemeIcon('warning');
        break;
      default:
        item.iconPath = kindIconPath('SCALAR');
    }

    // Modules reload in place (see hugr.refreshCatalogNode) — a 300-module
    // tree must not be torn down to refresh one branch.
    if (element.kind === 'module') {
      item.contextValue = 'hugrCatalogModule';
    }

    // A logical-model row opens its catalog view; a row that merely names a
    // GraphQL type opens the introspection view.
    if (element.open) {
      item.contextValue = 'hugrCatalogType';
      item.command = {
        command: 'hugr.showCatalogDetail',
        title: 'Show Details',
        arguments: [element.open],
      };
    } else if (element.typeName) {
      item.contextValue = 'hugrCatalogType';
      item.command = {
        command: 'hugr.showTypeDetail',
        title: 'Show Details',
        arguments: [element.typeName],
      };
    }

    return item;
  }

  async getChildren(element?: CatalogTreeNode): Promise<CatalogTreeNode[]> {
    if (!this._client) {
      return [];
    }
    if (!element) {
      if (this._error) {
        return [this._message(this._error)];
      }
      return this._roots;
    }
    if (!element.expandable) {
      return [];
    }
    if (element.childrenLoaded) {
      return element.children ?? [];
    }
    try {
      element.children = await this._fetchChildren(element);
      element.childrenLoaded = true;
    } catch (err) {
      // Shown but not CACHED: collapse and re-expand retries the fetch —
      // which is exactly what a user does after a transient failure.
      element.children = [this._message(err instanceof Error ? err.message : String(err))];
      element.childrenLoaded = false;
    }
    return element.children ?? [];
  }

  // -----------------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------------

  private async _loadRoots(): Promise<void> {
    if (!this._client) return;
    try {
      // Probe once per connection. The family arrived in v0.3.42, and an
      // engine without it should say so rather than render an empty tree that
      // looks like an empty catalog.
      const probe = await this._client.query('{ m: __type(name: "_Module") { name } }');
      if (!probe.data?.m?.name) {
        this._error =
          'This engine does not serve the logical-model catalog (_catalog). ' +
          'Use the Schema view, or upgrade the server.';
        this._roots = [];
        this._onDidChangeTreeData.fire(undefined);
        return;
      }
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this._roots = [];
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    this._error = null;
    this._roots = [
      {
        id: nextId(),
        kind: 'group',
        label: 'Modules',
        moduleName: '',
        expandable: true,
        childrenLoaded: false,
      },
      {
        id: nextId(),
        kind: 'group',
        label: 'Data Sources',
        expandable: true,
        childrenLoaded: false,
      },
      // The SDL-defined type definitions. Two scopes, both lazy — each is one
      // ~100-row metadata query, nothing like the generated surface.
      {
        id: nextId(),
        kind: 'group',
        label: 'Model Types',
        expandable: true,
        childrenLoaded: false,
      },
      {
        id: nextId(),
        kind: 'group',
        label: 'System Types',
        expandable: true,
        childrenLoaded: false,
      },
    ];
    this._onDidChangeTreeData.fire(undefined);
  }

  private async _fetchChildren(node: CatalogTreeNode): Promise<CatalogTreeNode[]> {
    const client = this._client!;

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
        childrenLoaded: true,
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
        detail: [t.kind ? t.kind.toLowerCase() : '', t.module ? `in ${t.module}` : '']
          .filter(Boolean)
          .join('  '),
        description: t.description || '',
        typeName: t.name,
        iconHint: t.kind || undefined,
        expandable: false,
        childrenLoaded: true,
      }));
    }

    if (node.kind === 'group' || node.kind === 'module') {
      const resp = await client.query(MODULE_QUERY, { m: node.moduleName ?? '' });
      this._throwOnErrors(resp);
      const mod = resp.data?._module;
      if (!mod) return [];
      const out: CatalogTreeNode[] = [];
      for (const m of mod.modules ?? []) {
        out.push({
          id: nextId(),
          kind: 'module',
          label: leafName(m.name),
          description: m.description || '',
          moduleName: m.name,
          expandable: true,
          childrenLoaded: false,
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
          iconHint: (o.type || 'TABLE').toLowerCase(),
          expandable: true,
          childrenLoaded: false,
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
          childrenLoaded: false,
        });
      }
      return out;
    }

    if (node.kind === 'dataObject') {
      const resp = await client.query(DATA_OBJECT_QUERY, { n: node.typeName });
      this._throwOnErrors(resp);
      const obj = resp.data?._dataObject;
      if (!obj) return [];
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
          childrenLoaded: true,
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
          childrenLoaded: true,
        });
      }
      const subqueries: CatalogTreeNode[] = [];
      for (const f of obj.fields ?? []) {
        const ht = f.hugr_type || '';
        if (HIDDEN_FIELD_HUGR_TYPES.has(ht)) continue;
        if (SUBQUERY_HUGR_TYPES.has(ht)) {
          subqueries.push({
            id: nextId(),
            kind: 'subquery',
            label: f.name,
            detail: hugrTypeLabel(ht).toLowerCase(),
            description: f.description || '',
            typeName: namedType(f.type),
            iconHint: ht,
            expandable: false,
            childrenLoaded: true,
          });
          continue;
        }
        out.push({
          id: nextId(),
          kind: 'field',
          label: pk.includes(f.name) ? `${f.name} (pk)` : f.name,
          detail: typeLabel(f.type),
          description: f.description || '',
          typeName: namedType(f.type),
          expandable: false,
          childrenLoaded: true,
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
          open: far ? { view: 'dataObject', name: far } : undefined,
          expandable: false,
          childrenLoaded: true,
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
      if (!fn) return [];
      const out: CatalogTreeNode[] = (fn.args ?? []).map((a: any) => ({
        id: nextId(),
        kind: 'arg' as const,
        label: a.name,
        detail: typeLabel(a.type),
        description: a.description || '',
        typeName: namedType(a.type),
        expandable: false,
        childrenLoaded: true,
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
          childrenLoaded: true,
        });
      }
      return out;
    }

    return [];
  }

  private _sourceDescription(s: any): string {
    const flags: string[] = [];
    if (s.readOnly) flags.push('read-only');
    if (s.asModule) flags.push('as module');
    if (s.isExtension) flags.push('extension');
    const modules = (s.modules ?? []).filter((m: string) => m).join(', ');
    return [s.description, flags.join(', '), modules && `modules: ${modules}`]
      .filter(Boolean)
      .join(' · ');
  }

  private _message(text: string): CatalogTreeNode {
    return {
      id: nextId(),
      kind: 'message',
      label: text,
      expandable: false,
      childrenLoaded: true,
    };
  }

  private _throwOnErrors(resp: any): void {
    if (resp?.errors?.length) {
      throw new Error(resp.errors.map((e: any) => e.message).join('; '));
    }
  }
}
