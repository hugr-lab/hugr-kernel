/**
 * VS Code HoverProvider for GraphQL.
 */
import * as vscode from 'vscode';

export class HugrHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | null> {
    const code = document.getText();
    const cursorPos = document.offsetAt(position);

    try {
      // Placeholder: actual implementation would use VS Code Jupyter kernel API
      return null;
    } catch (e) {
      return null;
    }
  }
}
