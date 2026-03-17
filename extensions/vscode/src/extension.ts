/**
 * VS Code extension for Hugr GraphQL IDE.
 *
 * Provides:
 * - Connection manager (read/write ~/.hugr/connections.json)
 * - Catalog and Schema explorer stubs (TODO: comm protocol)
 *
 * Completion is handled by the Jupyter extension via kernel protocol
 * (complete_request).
 */
import * as vscode from 'vscode';
import { ConnectionTreeProvider } from './connectionTreeProvider';
import { LogicalTreeProvider } from './explorer/logicalTreeProvider';
import { SchemaTreeProvider } from './explorer/schemaTreeProvider';

export function activate(context: vscode.ExtensionContext): void {
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

  // --- Explorer (stubs) ---
  const catalogProvider = new LogicalTreeProvider();
  vscode.window.registerTreeDataProvider('hugr.catalog', catalogProvider);
  const schemaProvider = new SchemaTreeProvider();
  vscode.window.registerTreeDataProvider('hugr.schema', schemaProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand('hugr.refreshCatalog', () => catalogProvider.refresh()),
    vscode.commands.registerCommand('hugr.refreshSchema', () => schemaProvider.refresh()),
  );
}

export function deactivate(): void {}
