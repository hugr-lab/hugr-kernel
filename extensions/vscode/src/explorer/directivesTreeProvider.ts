/**
 * Directives TreeDataProvider for VS Code.
 *
 * Shows all GraphQL directives from the schema with expandable arguments.
 * Ported from JupyterLab directivesList.ts.
 */
import * as vscode from 'vscode';
import { HugrClient } from './hugrClient';
import { unwrapType } from './icons';

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

export interface DirectiveTreeNode {
  id: string;
  label: string;
  nodeType: 'directive' | 'arg';
  directiveName?: string;
  description?: string;
  displayType?: string;
  defaultValue?: string;
  isRepeatable?: boolean;
  locations?: string[];
  children?: DirectiveTreeNode[];
  childrenLoaded: boolean;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const DIRECTIVES_QUERY = `{
  __schema {
    directives {
      name description locations isRepeatable
      args {
        name description defaultValue
        type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// ID counter
// ---------------------------------------------------------------------------

let _nextId = 0;
function nextDirId(): string {
  return `dir-${_nextId++}`;
}

// ---------------------------------------------------------------------------
// DirectivesTreeProvider
// ---------------------------------------------------------------------------

export class DirectivesTreeProvider implements vscode.TreeDataProvider<DirectiveTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DirectiveTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _client: HugrClient | null = null;
  private _directives: DirectiveTreeNode[] = [];
  private _loading = false;
  private _error: string | null = null;

  setClient(client: HugrClient | null): void {
    this._client = client;
    this._directives = [];
    this._error = null;
    if (client) {
      this._loadDirectives();
    } else {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  refresh(): void {
    this._directives = [];
    this._error = null;
    if (this._client) {
      this._loadDirectives();
    } else {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  getTreeItem(element: DirectiveTreeNode): vscode.TreeItem {
    const hasChildren = element.children && element.children.length > 0;
    const state = hasChildren
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(element.label, state);

    if (element.nodeType === 'directive') {
      item.description = element.description || '';
      item.iconPath = new vscode.ThemeIcon('symbol-event');
      item.contextValue = 'directive';

      const tooltipParts = [`@${element.directiveName}`];
      if (element.isRepeatable) tooltipParts.push('(repeatable)');
      if (element.description) tooltipParts.push(`\n${element.description}`);
      if (element.locations?.length) {
        tooltipParts.push(`\nLocations: ${element.locations.join(', ')}`);
      }
      item.tooltip = tooltipParts.join('');
    } else {
      // arg node
      item.description = element.displayType || '';
      if (element.defaultValue !== undefined) {
        item.description += ` = ${element.defaultValue}`;
      }
      item.iconPath = new vscode.ThemeIcon('symbol-parameter');
      item.tooltip = element.description || element.label;
    }

    return item;
  }

  async getChildren(element?: DirectiveTreeNode): Promise<DirectiveTreeNode[]> {
    if (!element) {
      if (this._error) {
        return [{
          id: 'error',
          label: `Error: ${this._error}`,
          nodeType: 'directive',
          childrenLoaded: true,
        }];
      }
      if (this._loading) {
        return [{
          id: 'loading',
          label: 'Loading directives...',
          nodeType: 'directive',
          childrenLoaded: true,
        }];
      }
      if (!this._client) {
        return [{
          id: 'no-connection',
          label: 'No connection selected',
          nodeType: 'directive',
          childrenLoaded: true,
        }];
      }
      return this._directives;
    }

    return element.children ?? [];
  }

  // -------------------------------------------------------------------------
  // Load directives
  // -------------------------------------------------------------------------

  private async _loadDirectives(): Promise<void> {
    if (!this._client) return;

    this._loading = true;
    this._error = null;
    this._onDidChangeTreeData.fire(undefined);

    try {
      const res = await this._client.query(DIRECTIVES_QUERY);

      if (res.errors?.length) {
        this._error = res.errors.map(e => e.message).join('; ');
        this._loading = false;
        this._onDidChangeTreeData.fire(undefined);
        return;
      }

      const rawDirectives: any[] = res.data?.__schema?.directives ?? [];

      this._directives = rawDirectives.map((d: any) => {
        const args: any[] = d.args ?? [];
        const argNodes: DirectiveTreeNode[] = args.map((a: any) => {
          const unwrapped = unwrapType(a.type);
          return {
            id: nextDirId(),
            label: a.name,
            nodeType: 'arg' as const,
            displayType: unwrapped.displayType,
            description: a.description ?? undefined,
            defaultValue: a.defaultValue ?? undefined,
            childrenLoaded: true,
          };
        });

        return {
          id: nextDirId(),
          label: `@${d.name}`,
          nodeType: 'directive' as const,
          directiveName: d.name,
          description: d.description ?? undefined,
          isRepeatable: !!d.isRepeatable,
          locations: d.locations ?? [],
          children: argNodes,
          childrenLoaded: true,
        };
      });

      this._loading = false;
      this._onDidChangeTreeData.fire(undefined);
    } catch (err: any) {
      this._error = err?.message ?? 'Failed to load directives';
      this._loading = false;
      this._onDidChangeTreeData.fire(undefined);
    }
  }
}
