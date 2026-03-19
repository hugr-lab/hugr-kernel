/**
 * VS Code extension for Hugr GraphQL IDE.
 *
 * Provides:
 * - Connection manager (read/write ~/.hugr/connections.json)
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
import { DirectivesTreeProvider } from './explorer/directivesTreeProvider';
import { TypesSearchProvider } from './explorer/typesSearchProvider';
import { showTypeDetail, showDirectiveDetail } from './explorer/detailPanel';
import { setExtensionUri } from './explorer/icons';

export function activate(context: vscode.ExtensionContext): void {
  // Set extension URI for icon resolution
  setExtensionUri(context.extensionUri);

  // --- Jupyter kernel completion trigger characters for GraphQL ---
  const config = vscode.workspace.getConfiguration('jupyter');
  const triggers = config.get<Record<string, string[]>>('completionTriggerCharacters') || {};
  if (!triggers['graphql']) {
    triggers['graphql'] = ['{', '(', ' ', '@', '$', ':'];
    config.update('completionTriggerCharacters', triggers, vscode.ConfigurationTarget.Global);
  }

  // --- Connection Manager ---
  const connectionProvider = new ConnectionTreeProvider();
  vscode.window.registerTreeDataProvider('hugr.connections', connectionProvider);
  context.subscriptions.push({ dispose: () => connectionProvider.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('hugr.addConnection', () => connectionProvider.addConnection()),
    vscode.commands.registerCommand('hugr.removeConnection', (entry) => connectionProvider.removeConnection(entry)),
    vscode.commands.registerCommand('hugr.setDefaultConnection', (entry) => connectionProvider.setDefault(entry)),
    vscode.commands.registerCommand('hugr.testConnection', (entry) => connectionProvider.testConnection(entry)),
    vscode.commands.registerCommand('hugr.editConnection', (entry) => connectionProvider.editConnection(entry)),
    vscode.commands.registerCommand('hugr.refreshConnections', () => connectionProvider.refresh()),
  );

  // --- Schema Tree ---
  const schemaProvider = new SchemaTreeProvider();
  vscode.window.registerTreeDataProvider('hugr.schema', schemaProvider);

  // --- Directives ---
  const directivesProvider = new DirectivesTreeProvider();
  vscode.window.registerTreeDataProvider('hugr.directives', directivesProvider);

  // --- Types Search ---
  const typesSearchProvider = new TypesSearchProvider(
    context.extensionUri,
    (typeName: string) => {
      const client = connectionProvider.createClient();
      if (client) {
        showTypeDetail(typeName, client);
      }
    },
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('hugr.types', typesSearchProvider),
  );

  // --- Connection change handler ---
  const updateProvidersClient = () => {
    const client = connectionProvider.createClient();
    schemaProvider.setClient(client);
    directivesProvider.setClient(client);
    typesSearchProvider.setClient(client);
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
        typesSearchProvider.searchFor(typeName);
        vscode.commands.executeCommand('hugr.types.focus');
      }
    }),
  );
}

export function deactivate(): void {}
