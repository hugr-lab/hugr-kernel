/**
 * VS Code extension for Hugr GraphQL IDE.
 */
import * as vscode from 'vscode';
import { ConnectionTreeProvider } from './connectionTreeProvider';
import { LogicalTreeProvider } from './explorer/logicalTreeProvider';
import { SchemaTreeProvider } from './explorer/schemaTreeProvider';
import { HugrCompletionProvider } from './graphql/completionProvider';
import { HugrHoverProvider } from './graphql/hoverProvider';
import { HugrDiagnosticProvider } from './graphql/diagnosticProvider';
import { HugrFormattingProvider } from './graphql/formatting';

const GRAPHQL_SELECTOR: vscode.DocumentSelector = { language: 'graphql' };

export function activate(context: vscode.ExtensionContext): void {
  // Connection management
  const connectionProvider = new ConnectionTreeProvider();
  vscode.window.registerTreeDataProvider('hugr-connections', connectionProvider);

  // Explorer trees
  const catalogProvider = new LogicalTreeProvider();
  vscode.window.registerTreeDataProvider('hugr-catalog', catalogProvider);
  const schemaProvider = new SchemaTreeProvider();
  vscode.window.registerTreeDataProvider('hugr-schema', schemaProvider);

  // Language features
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(GRAPHQL_SELECTOR, new HugrCompletionProvider(), '{', '(', ' '),
    vscode.languages.registerHoverProvider(GRAPHQL_SELECTOR, new HugrHoverProvider()),
    vscode.languages.registerDocumentFormattingEditProvider(GRAPHQL_SELECTOR, new HugrFormattingProvider()),
  );

  // Diagnostics
  const diagnosticProvider = new HugrDiagnosticProvider(context);

  // Refresh commands
  context.subscriptions.push(
    vscode.commands.registerCommand('hugr.refreshConnections', () => connectionProvider.refresh()),
    vscode.commands.registerCommand('hugr.refreshCatalog', () => catalogProvider.refresh()),
    vscode.commands.registerCommand('hugr.refreshSchema', () => schemaProvider.refresh()),
  );
}

export function deactivate(): void {}
