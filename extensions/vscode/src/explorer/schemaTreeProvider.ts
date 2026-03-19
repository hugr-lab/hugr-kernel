/**
 * Schema Explorer TreeDataProvider for VS Code.
 *
 * Provides a lazy-loading tree of the GraphQL schema with
 * Query/Mutation/Subscription roots, expandable fields, args,
 * and return types. Ported from JupyterLab schemaTree.ts.
 */
import * as vscode from 'vscode';
import { HugrClient } from './hugrClient';
import { kindIconPath, hugrTypeIconPath, hugrTypeLabel, unwrapType } from './icons';

// ---------------------------------------------------------------------------
// Node interface
// ---------------------------------------------------------------------------

export interface SchemaTreeNode {
  id: string;
  label: string;
  nodeType: 'root' | 'field' | 'args_group' | 'arg' | 'input_field' | 'enum_value';
  typeName?: string;
  typeKind?: string;
  displayType?: string;
  hugrType?: string;
  catalog?: string;
  module?: string;
  description?: string;
  defaultValue?: string;
  children?: SchemaTreeNode[];
  childrenLoaded: boolean;
  /** Whether return-type fields have been loaded for a field node. */
  returnTypeLoaded?: boolean;
}

// ---------------------------------------------------------------------------
// Introspection queries
// ---------------------------------------------------------------------------

const ROOTS_QUERY = `{
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
  }
}`;

function typeQuery(typeName: string): string {
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

// ---------------------------------------------------------------------------
// ID counter
// ---------------------------------------------------------------------------

let _nextId = 0;
function nextId(): string {
  return `stn-${_nextId++}`;
}

// ---------------------------------------------------------------------------
// SchemaTreeProvider
// ---------------------------------------------------------------------------

export class SchemaTreeProvider implements vscode.TreeDataProvider<SchemaTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SchemaTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _client: HugrClient | null = null;
  private _roots: SchemaTreeNode[] = [];
  private _loading = false;
  private _error: string | null = null;

  setClient(client: HugrClient | null): void {
    this._client = client;
    this._roots = [];
    this._error = null;
    if (client) {
      this._loadRoots();
    } else {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  refresh(): void {
    this._roots = [];
    this._error = null;
    if (this._client) {
      this._loadRoots();
    } else {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  refreshNode(node: SchemaTreeNode): void {
    this._resetNode(node);
    // Fire undefined to force full tree refresh — VS Code doesn't collapse
    // individual nodes, so we must rebuild the entire tree view.
    this._onDidChangeTreeData.fire(undefined);
  }

  private _resetNode(node: SchemaTreeNode): void {
    if (node.children) {
      for (const child of node.children) {
        this._resetNode(child);
      }
    }
    node.children = undefined;
    node.childrenLoaded = false;
    node.returnTypeLoaded = undefined;
  }

  getTreeItem(element: SchemaTreeNode): vscode.TreeItem {
    const hasChildren = this._nodeHasChildren(element);
    const state = hasChildren
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(element.label, state);

    // Description (return type)
    if (element.displayType) {
      item.description = element.displayType;
    }

    // Default value for args/input fields
    if (element.defaultValue !== undefined) {
      const desc = element.displayType
        ? `${element.displayType} = ${element.defaultValue}`
        : `= ${element.defaultValue}`;
      item.description = desc;
    }

    // Tooltip
    const tooltipParts: string[] = [element.label];
    if (element.displayType) tooltipParts.push(`: ${element.displayType}`);
    if (element.hugrType) tooltipParts.push(`\n${hugrTypeLabel(element.hugrType)}`);
    if (element.description) tooltipParts.push(`\n${element.description}`);
    item.tooltip = tooltipParts.join('');

    // Icon
    if (element.hugrType) {
      item.iconPath = hugrTypeIconPath(element.hugrType);
    } else if (element.nodeType === 'root') {
      item.iconPath = kindIconPath('OBJECT');
    } else if (element.nodeType === 'args_group') {
      item.iconPath = new vscode.ThemeIcon('symbol-parameter');
    } else if (element.nodeType === 'enum_value') {
      item.iconPath = kindIconPath('ENUM');
    } else if (element.typeKind) {
      item.iconPath = kindIconPath(element.typeKind);
    } else {
      item.iconPath = kindIconPath('SCALAR');
    }

    // Context value for menus
    const contextParts: string[] = [];
    if (element.typeName) contextParts.push('hasTypeName');
    if (hasChildren) contextParts.push('expandable');
    item.contextValue = contextParts.join(',');

    return item;
  }

  async getChildren(element?: SchemaTreeNode): Promise<SchemaTreeNode[]> {
    if (!element) {
      // Root level
      if (this._error) {
        return [{
          id: 'error',
          label: `Error: ${this._error}`,
          nodeType: 'root',
          childrenLoaded: true,
        }];
      }
      if (this._loading) {
        return [{
          id: 'loading',
          label: 'Loading schema...',
          nodeType: 'root',
          childrenLoaded: true,
        }];
      }
      if (!this._client) {
        return [{
          id: 'no-connection',
          label: 'No connection selected',
          nodeType: 'root',
          childrenLoaded: true,
        }];
      }
      return this._roots;
    }

    // Already loaded
    if (element.childrenLoaded && element.children) {
      // For field nodes with expandable return types, load return type fields lazily
      if (element.nodeType === 'field' && element.returnTypeLoaded === false) {
        await this._loadReturnTypeFields(element);
      }
      return element.children;
    }

    // Need to load children
    if (!this._client || !element.typeName) {
      return [];
    }

    try {
      const res = await this._client.query(typeQuery(element.typeName));
      if (res.errors?.length) {
        return [];
      }

      const typeData = res.data?.__type;
      if (!typeData) {
        element.childrenLoaded = true;
        element.children = [];
        return [];
      }

      element.children = this._buildChildren(typeData);
      element.childrenLoaded = true;
      return element.children;
    } catch {
      element.childrenLoaded = true;
      element.children = [];
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Load roots
  // -------------------------------------------------------------------------

  private async _loadRoots(): Promise<void> {
    if (!this._client) return;

    this._loading = true;
    this._error = null;
    this._onDidChangeTreeData.fire(undefined);

    try {
      const res = await this._client.query(ROOTS_QUERY);

      if (res.errors?.length) {
        this._error = res.errors.map(e => e.message).join('; ');
        this._loading = false;
        this._onDidChangeTreeData.fire(undefined);
        return;
      }

      const schema = res.data?.__schema;
      if (!schema) {
        this._error = 'No schema data returned';
        this._loading = false;
        this._onDidChangeTreeData.fire(undefined);
        return;
      }

      this._roots = [];
      if (schema.queryType?.name) {
        this._roots.push({
          id: nextId(),
          label: 'Query',
          nodeType: 'root',
          typeName: schema.queryType.name,
          typeKind: 'OBJECT',
          childrenLoaded: false,
        });
      }
      if (schema.mutationType?.name) {
        this._roots.push({
          id: nextId(),
          label: 'Mutation',
          nodeType: 'root',
          typeName: schema.mutationType.name,
          typeKind: 'OBJECT',
          childrenLoaded: false,
        });
      }
      if (schema.subscriptionType?.name) {
        this._roots.push({
          id: nextId(),
          label: 'Subscription',
          nodeType: 'root',
          typeName: schema.subscriptionType.name,
          typeKind: 'OBJECT',
          childrenLoaded: false,
        });
      }

      this._loading = false;
      this._onDidChangeTreeData.fire(undefined);
    } catch (err: any) {
      this._error = err?.message ?? 'Failed to load schema roots';
      this._loading = false;
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Load return type fields for a field node (lazy)
  // -------------------------------------------------------------------------

  private async _loadReturnTypeFields(node: SchemaTreeNode): Promise<void> {
    if (!this._client || !node.typeName) {
      node.returnTypeLoaded = true;
      return;
    }

    if (node.typeKind !== 'OBJECT' && node.typeKind !== 'INTERFACE') {
      node.returnTypeLoaded = true;
      return;
    }

    try {
      const res = await this._client.query(typeQuery(node.typeName));
      const typeData = res.data?.__type;

      if (typeData && (typeData.kind === 'OBJECT' || typeData.kind === 'INTERFACE')) {
        const fieldChildren = this._buildFieldChildren(typeData.fields ?? []);
        if (!node.children) node.children = [];
        node.children.push(...fieldChildren);
      }
    } catch {
      // Silently fail — args are still visible
    }

    node.returnTypeLoaded = true;
    this._onDidChangeTreeData.fire(node);
  }

  // -------------------------------------------------------------------------
  // Build children from introspection data
  // -------------------------------------------------------------------------

  private _buildChildren(typeData: any): SchemaTreeNode[] {
    const kind: string = typeData.kind;

    if (kind === 'OBJECT' || kind === 'INTERFACE') {
      return this._buildFieldChildren(typeData.fields ?? []);
    }

    if (kind === 'INPUT_OBJECT') {
      return this._buildInputFieldChildren(typeData.inputFields ?? []);
    }

    if (kind === 'ENUM') {
      return (typeData.enumValues ?? []).map((ev: any) => ({
        id: nextId(),
        label: ev.name,
        nodeType: 'enum_value' as const,
        description: ev.description ?? undefined,
        childrenLoaded: true,
      }));
    }

    return [];
  }

  private _buildFieldChildren(fields: any[]): SchemaTreeNode[] {
    const nodes: SchemaTreeNode[] = [];

    for (const field of fields) {
      const unwrapped = unwrapType(field.type);
      const args: any[] = field.args ?? [];
      const hasArgs = args.length > 0;
      const returnTypeExpandable =
        unwrapped.kind === 'OBJECT' || unwrapped.kind === 'INTERFACE';

      const fieldNode: SchemaTreeNode = {
        id: nextId(),
        label: field.name,
        nodeType: 'field',
        typeName: unwrapped.baseName,
        typeKind: unwrapped.kind,
        displayType: unwrapped.displayType,
        hugrType: field.hugr_type ?? undefined,
        catalog: field.catalog ?? undefined,
        description: field.description ?? undefined,
        childrenLoaded: false,
      };

      if (hasArgs || returnTypeExpandable) {
        fieldNode.children = [];
        fieldNode.childrenLoaded = true;

        if (hasArgs) {
          const argsGroup: SchemaTreeNode = {
            id: nextId(),
            label: `args (${args.length})`,
            nodeType: 'args_group',
            childrenLoaded: true,
            children: this._buildArgChildren(args),
          };
          fieldNode.children.push(argsGroup);
        }

        if (returnTypeExpandable) {
          fieldNode.returnTypeLoaded = false;
        }
      } else {
        // Leaf field (SCALAR, ENUM without children, etc.)
        fieldNode.childrenLoaded = true;
      }

      nodes.push(fieldNode);
    }

    return nodes;
  }

  private _buildArgChildren(args: any[]): SchemaTreeNode[] {
    return args.map((arg: any) => {
      const unwrapped = unwrapType(arg.type);
      const isExpandable =
        unwrapped.kind === 'INPUT_OBJECT' || unwrapped.kind === 'ENUM';

      return {
        id: nextId(),
        label: arg.name,
        nodeType: 'arg' as const,
        typeName: unwrapped.baseName,
        typeKind: unwrapped.kind,
        displayType: unwrapped.displayType,
        description: arg.description ?? undefined,
        defaultValue: arg.defaultValue ?? undefined,
        childrenLoaded: !isExpandable,
      };
    });
  }

  private _buildInputFieldChildren(inputFields: any[]): SchemaTreeNode[] {
    return inputFields.map((field: any) => {
      const unwrapped = unwrapType(field.type);
      const isExpandable =
        unwrapped.kind === 'INPUT_OBJECT' || unwrapped.kind === 'ENUM';

      return {
        id: nextId(),
        label: field.name,
        nodeType: 'input_field' as const,
        typeName: unwrapped.baseName,
        typeKind: unwrapped.kind,
        displayType: unwrapped.displayType,
        description: field.description ?? undefined,
        defaultValue: field.defaultValue ?? undefined,
        childrenLoaded: !isExpandable,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private _nodeHasChildren(node: SchemaTreeNode): boolean {
    if (node.nodeType === 'enum_value') return false;

    // Field with return type not loaded yet
    if (node.nodeType === 'field' && node.returnTypeLoaded === false) return true;

    // Args group always has children
    if (node.nodeType === 'args_group') return true;

    // Not yet loaded
    if (!node.childrenLoaded) return true;

    // Has children array with items
    if (node.children && node.children.length > 0) return true;

    return false;
  }
}
