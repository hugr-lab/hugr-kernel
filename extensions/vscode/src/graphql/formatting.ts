/**
 * VS Code DocumentFormattingEditProvider for GraphQL using Prettier.
 */
import * as vscode from 'vscode';

export class HugrFormattingProvider implements vscode.DocumentFormattingEditProvider {
  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    try {
      const prettier = require('prettier');
      const text = document.getText();
      const formatted = await prettier.format(text, {
        parser: 'graphql',
        tabWidth: options.tabSize,
        useTabs: !options.insertSpaces,
      });

      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length),
      );
      return [vscode.TextEdit.replace(fullRange, formatted)];
    } catch (e) {
      console.error('Formatting failed', e);
      return [];
    }
  }
}
