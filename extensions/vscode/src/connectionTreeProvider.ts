/**
 * Connection tree provider for VS Code Activity Bar.
 */
import * as vscode from 'vscode';

interface ConnectionItem {
  name: string;
  url: string;
  auth_type: string;
  read_only: boolean;
}

export class ConnectionTreeProvider implements vscode.TreeDataProvider<ConnectionItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ConnectionItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _connections: ConnectionItem[] = [];

  refresh(): void {
    this._loadConnections();
  }

  getTreeItem(element: ConnectionItem): vscode.TreeItem {
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    item.description = `${element.url} [${element.auth_type}]`;
    item.tooltip = `${element.name}\n${element.url}\nAuth: ${element.auth_type}`;
    item.iconPath = element.read_only ? new vscode.ThemeIcon('lock') : new vscode.ThemeIcon('plug');
    return item;
  }

  async getChildren(element?: ConnectionItem): Promise<ConnectionItem[]> {
    if (element) return [];
    await this._loadConnections();
    return this._connections;
  }

  private async _loadConnections(): Promise<void> {
    try {
      // In VS Code context, connections come from REST API
      // This is a placeholder - actual implementation uses fetch or VS Code API
      this._connections = [];
      this._onDidChangeTreeData.fire(undefined);
    } catch (e) {
      console.error('Failed to load connections', e);
    }
  }
}
