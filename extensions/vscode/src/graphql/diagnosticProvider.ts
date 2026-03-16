/**
 * VS Code DiagnosticCollection manager for GraphQL.
 */
import * as vscode from 'vscode';

export class HugrDiagnosticProvider {
  private _diagnostics: vscode.DiagnosticCollection;

  constructor(context: vscode.ExtensionContext) {
    this._diagnostics = vscode.languages.createDiagnosticCollection('hugr-graphql');
    context.subscriptions.push(this._diagnostics);
  }

  updateDiagnostics(uri: vscode.Uri, diagnostics: any[]): void {
    const vsDiagnostics = diagnostics.map(d => {
      const range = new vscode.Range(
        d.startLine, d.startColumn,
        d.endLine, d.endColumn,
      );
      const severity = d.severity === 'Error'
        ? vscode.DiagnosticSeverity.Error
        : d.severity === 'Warning'
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Information;

      const diag = new vscode.Diagnostic(range, d.message, severity);
      diag.source = 'hugr';
      diag.code = d.code;
      return diag;
    });

    this._diagnostics.set(uri, vsDiagnostics);
  }
}
