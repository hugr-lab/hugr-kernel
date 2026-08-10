/**
 * VS Code extension for Hugr GraphQL IDE.
 *
 * Provides:
 * - Connection manager (read/write ~/.hugr/connections.json)
 * - OIDC browser login for browser auth connections
 * - Schema explorer with lazy-loading tree
 * - Types search with pagination
 * - Directives list
 * - Type/directive detail panels
 *
 * Completion is handled by the Jupyter extension via kernel protocol
 * (complete_request).
 */
import * as vscode from 'vscode';
import { ConnectionTreeProvider } from './connectionTreeProvider';
import { SchemaTreeProvider, SchemaTreeNode } from './explorer/schemaTreeProvider';
import { CatalogTreeProvider, CatalogTreeNode } from './explorer/catalogTreeProvider';
import { DirectivesTreeProvider } from './explorer/directivesTreeProvider';
import { SearchViewProvider } from './explorer/searchViewProvider';
import { showTypeDetail, showDirectiveDetail, showDetail, DetailTarget } from './explorer/detailPanel';
import { setExtensionUri } from './explorer/icons';
import { installKernel } from './installKernel';

export function activate(context: vscode.ExtensionContext): void {
  // Set extension URI for icon resolution
  setExtensionUri(context.extensionUri);

  // --- Output channel for install logs ---
  const log = vscode.window.createOutputChannel('Hugr Kernel');
  context.subscriptions.push(log);

  // --- Install Kernel command ---
  context.subscriptions.push(
    vscode.commands.registerCommand('hugr.installKernel', async () => {
      try {
        await installKernel(log);
      } catch (e: any) {
        log.appendLine(`Install failed: ${e.message}`);
        vscode.window.showErrorMessage(`Hugr Kernel install failed: ${e.message}`);
      }
    }),
  );

  // --- Jupyter kernel completion trigger characters for GraphQL ---
  const config = vscode.workspace.getConfiguration('jupyter');
  const triggers = config.get<Record<string, string[]>>('completionTriggerCharacters') || {};
  if (!triggers['graphql']) {
    triggers['graphql'] = ['{', '(', ' ', '@', '$', ':'];
    config.update('completionTriggerCharacters', triggers, vscode.ConfigurationTarget.Global);
  }

  // --- Connection Manager ---
  const connectionProvider = new ConnectionTreeProvider(context.secrets);
  vscode.window.registerTreeDataProvider('hugr.connections', connectionProvider);
  context.subscriptions.push({ dispose: () => connectionProvider.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('hugr.addConnection', () => connectionProvider.addConnection()),
    vscode.commands.registerCommand('hugr.removeConnection', (entry) => connectionProvider.removeConnection(entry)),
    vscode.commands.registerCommand('hugr.setDefaultConnection', (entry) => connectionProvider.setDefault(entry)),
    vscode.commands.registerCommand('hugr.testConnection', (entry) => connectionProvider.testConnection(entry)),
    vscode.commands.registerCommand('hugr.editConnection', (entry) => connectionProvider.editConnection(entry)),
    vscode.commands.registerCommand('hugr.refreshConnections', () => connectionProvider.refresh()),
    // Same effect as flipping the default away and back: fresh clients for
    // every panel and a full reload — for after a login or a config change.
    vscode.commands.registerCommand('hugr.reloadConnection', () => {
      connectionProvider.refresh();
      connectionProvider.notifyAuthChanged();
    }),
    vscode.commands.registerCommand('hugr.loginConnection', (entry) => connectionProvider.loginConnection(entry)),
    vscode.commands.registerCommand('hugr.logoutConnection', (entry) => connectionProvider.logoutConnection(entry)),
  );

  // --- Schema Tree ---
  const schemaProvider = new SchemaTreeProvider();
  vscode.window.registerTreeDataProvider('hugr.schema', schemaProvider);

  // --- Catalog Tree (logical model) ---
  const catalogProvider = new CatalogTreeProvider();
  vscode.window.registerTreeDataProvider('hugr.catalog', catalogProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand('hugr.showCatalogDetail', (target: DetailTarget) => {
      const client = connectionProvider.createClient();
      if (!client) {
        vscode.window.showWarningMessage('No connection available');
        return;
      }
      if (target?.view && target?.name != null) {
        showDetail(target, client);
      }
    }),
    vscode.commands.registerCommand('hugr.refreshCatalog', () => catalogProvider.refresh()),
    vscode.commands.registerCommand('hugr.refreshCatalogNode', (node: CatalogTreeNode) => {
      if (node) {
        catalogProvider.refreshNode(node);
      }
    }),
  );

  // --- Directives ---
  const directivesProvider = new DirectivesTreeProvider();
  vscode.window.registerTreeDataProvider('hugr.directives', directivesProvider);

  // --- Search (the logical-model _search, in the section Types used to hold) ---
  const searchProvider = new SearchViewProvider(
    context.extensionUri,
    (target: DetailTarget) => {
      const client = connectionProvider.createClient();
      if (client) {
        showDetail(target, client);
      }
    },
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('hugr.types', searchProvider),
  );

  // --- Connection change handler ---
  const updateProvidersClient = () => {
    const client = connectionProvider.createClient();
    schemaProvider.setClient(client);
    catalogProvider.setClient(client);
    directivesProvider.setClient(client);
    searchProvider.setClient(client);
  };

  // Subscribe to default connection changes
  context.subscriptions.push(
    connectionProvider.onDidChangeDefault(() => {
      updateProvidersClient();
    }),
  );

  // Initialize with current default connection
  updateProvidersClient();

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('hugr.refreshSchema', () => schemaProvider.refresh()),
    vscode.commands.registerCommand('hugr.refreshDirectives', () => directivesProvider.refresh()),

    vscode.commands.registerCommand('hugr.refreshSchemaNode', (node: SchemaTreeNode) => {
      schemaProvider.refreshNode(node);
    }),

    vscode.commands.registerCommand('hugr.showTypeDetail', (nodeOrName: SchemaTreeNode | string) => {
      const client = connectionProvider.createClient();
      if (!client) {
        vscode.window.showWarningMessage('No connection available');
        return;
      }
      const typeName = typeof nodeOrName === 'string'
        ? nodeOrName
        : nodeOrName?.typeName;
      if (typeName) {
        showTypeDetail(typeName, client);
      }
    }),

    vscode.commands.registerCommand('hugr.searchType', (nodeOrName: SchemaTreeNode | string) => {
      const typeName = typeof nodeOrName === 'string'
        ? nodeOrName
        : nodeOrName?.typeName;
      if (typeName) {
        searchProvider.searchFor(typeName);
        vscode.commands.executeCommand('hugr.types.focus');
      }
    }),
  );
}

export function deactivate(): void {}
