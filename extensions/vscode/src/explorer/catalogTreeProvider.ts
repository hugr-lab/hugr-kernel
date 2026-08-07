/**
 * Catalog Explorer TreeDataProvider for VS Code — hugr's LOGICAL model.
 *
 * The Schema view shows the served GraphQL surface: hundreds of generated
 * filters, aggregations and mutation inputs around the handful of things a
 * user actually came to look at. This view shows the model those were
 * generated FROM — the module tree, the data objects with their relations, the
 * callable functions, and the sources they came from — through the `_catalog`
 * meta queries, which the engine resolves on the metadata path and filters per
 * role.
 *
 * Every level is one query for one node, issued when the node is opened. The
 * meta queries have a depth budget, so asking for the whole tree at once is
 * both slower and liable to be truncated; asking per node never is.
 *
 * The view title carries a Search action: `_search` is the engine's own ranking
 * over the same model — semantic where the deployment has an embedder,
 * substring matching where it does not, and it says which. Results replace the
 * tree until the search is cleared. Engines older than `_search` do not get the
 * action.
 *
 * Ported from JupyterLab catalogTree.ts — keep the two in step.
 */
import * as vscode from 'vscode';
import { HugrClient } from './hugrClient';
import { kindIconPath, hugrTypeIconPath } from './icons';

export type SearchMatch = 'NAME' | 'MEANING' | 'BOTH';

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

const SEARCH_QUERY = `query($q: String!, $m: _SearchMatch!) {
  _search(query: $q, match: $m, limit: 50) {
    lexical
    lexicalReason
    hasMore
    filteredOut
    items {
      kind matchedOn name moduleName dataSourceName description score
      objectName type hugrType refObjectName
    }
  }
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
  /** Non-null while a search is showing instead of the tree. */
  private _hits: CatalogTreeNode[] | null = null;
  /**
   * What a search matches on. Name and meaning are different questions — a
   * name never enters the vector index, which is built from descriptions — and
   * BOTH is the default because a user rarely decides in advance which one
   * they are asking.
   */
  private _match: SearchMatch = 'BOTH';
  /** The last query, so a mode change re-runs it instead of asking again. */
  private _lastQuery = '';
  private _searchAvailable = false;

  get searchAvailable(): boolean {
    return this._searchAvailable;
  }

  setClient(client: HugrClient | null): void {
    this._client = client;
    this._roots = [];
    this._error = null;
    this._hits = null;
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
      // A refresh reloads the tree, so it must also leave the search: keeping
      // stale hits over a freshly reloaded model is the one state where the
      // view would show something the engine no longer says.
      this._hits = null;
      void this._loadRoots();
    }
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
        item.iconPath = hugrTypeIconPath(element.detail === 'view' ? 'view' : 'table');
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
        item.iconPath = new vscode.ThemeIcon('play');
        break;
      case 'message':
        item.iconPath = new vscode.ThemeIcon('warning');
        break;
      default:
        item.iconPath = kindIconPath('SCALAR');
    }

    // Only rows that name a type can open one.
    if (element.typeName) {
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
      // A search replaces the tree until it is cleared.
      if (this._hits !== null) {
        return this._hits;
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
    } catch (err) {
      element.children = [this._message(err instanceof Error ? err.message : String(err))];
    }
    element.childrenLoaded = true;
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
      const probe = await this._client.query(
        '{ m: __type(name: "_Module") { name } s: __type(name: "_SearchResult") { name } }'
      );
      // _search is newer than the rest of the family: an engine can serve the
      // tree and not the search.
      this._searchAvailable = !!probe.data?.s?.name;
      void vscode.commands.executeCommand(
        'setContext', 'hugr.catalogSearchAvailable', this._searchAvailable
      );
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
        out.push({
          id: nextId(),
          kind: 'query',
          label: q.name,
          detail: (q.type || '').toLowerCase(),
          expandable: false,
          childrenLoaded: true,
        });
      }
      for (const f of obj.fields ?? []) {
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
      for (const r of obj.relations ?? []) {
        const far = r.dataObject?.name;
        out.push({
          id: nextId(),
          kind: 'relation',
          label: r.fieldName || r.name,
          detail: `${(r.kind || '').toLowerCase()} → ${far ?? '?'}`,
          typeName: far,
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

  /**
   * Run `_search` and show its hits instead of the tree.
   *
   * The note row is not decoration: without a vector index the ranking is
   * substring matching and every word of the query has to appear, so "customer
   * orders" finds nothing a semantic ranking would have found. filteredOut
   * says the deployment holds matches this role may not see.
   */
  get match(): SearchMatch {
    return this._match;
  }

  /** Change the track and re-run the last query, if there was one. */
  async setMatch(match: SearchMatch): Promise<void> {
    this._match = match;
    if (this._lastQuery) {
      await this.search(this._lastQuery);
    }
  }

  async search(query: string): Promise<void> {
    if (!this._client || !query.trim()) {
      this.clearSearch();
      return;
    }
    this._lastQuery = query.trim();
    try {
      const resp = await this._client.query(SEARCH_QUERY, { q: query.trim(), m: this._match });
      this._throwOnErrors(resp);
      const page = resp.data?._search;
      const hits: CatalogTreeNode[] = (page?.items ?? []).map((h: any) => {
        // A field hit is only actionable through its owner, so that is what
        // the row names and what clicking it opens.
        const isField = h.kind === 'FIELD';
        const detail = [
          isField ? h.type : '',
          h.moduleName ? `in ${h.moduleName}` : '',
          h.refObjectName ? `→ ${h.refObjectName}` : '',
        ]
          .filter(Boolean)
          .join('  ');
        return {
          id: nextId(),
          kind: isField ? ('field' as const) : this._hitKind(h.kind),
          label: isField ? `${h.objectName}.${h.name}` : h.name,
          // Mark which track found it. An exact name and an embedding distance
          // are not on one scale, so a name hit is not "better" than a meaning
          // hit — it is an answer to a different question.
          detail: h.matchedOn === 'NAME' ? [detail, '(name)'].filter(Boolean).join('  ') : detail,
          description: h.description || '',
          typeName: isField ? h.objectName : h.name,
          expandable: false,
          childrenLoaded: true,
        };
      });
      const note = this._noteFor(page);
      this._hits = note ? [this._message(note), ...hits] : hits;
      if (hits.length === 0) {
        this._hits.push(this._message('Nothing matches'));
      }
    } catch (err) {
      this._hits = [this._message(err instanceof Error ? err.message : String(err))];
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  clearSearch(): void {
    this._hits = null;
    this._lastQuery = '';
    this._onDidChangeTreeData.fire(undefined);
  }

  private _hitKind(kind: string): CatalogNodeKind {
    switch (kind) {
      case 'MODULE':
        return 'module';
      case 'DATA_OBJECT':
        return 'dataObject';
      case 'FUNCTION':
        return 'function';
      case 'DATA_SOURCE':
        return 'dataSource';
      default:
        return 'field';
    }
  }

  private _noteFor(page: any): string {
    if (!page) return '';
    const bits: string[] = [
      this._match === 'BOTH' ? 'matching names and meaning' :
        this._match === 'NAME' ? 'matching names only' : 'matching meaning only',
    ];
    if (this._match !== 'NAME' && page.lexical) {
      bits.push('no vector index — substring matching, every word must appear');
    }
    if (page.filteredOut > 0) bits.push(`${page.filteredOut} hidden from you`);
    if (page.hasMore) bits.push('more matches exist — narrow the query');
    return bits.join(' · ');
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
