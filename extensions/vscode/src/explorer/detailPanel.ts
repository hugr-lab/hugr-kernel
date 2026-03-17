/**
 * WebviewPanel for entity detail views in VS Code.
 */
import * as vscode from 'vscode';

export class DetailPanel {
  private _panel: vscode.WebviewPanel | null = null;

  show(detail: any): void {
    if (!this._panel) {
      this._panel = vscode.window.createWebviewPanel(
        'hugrDetail',
        'Hugr Detail',
        vscode.ViewColumn.Beside,
        { enableScripts: false },
      );
      this._panel.onDidDispose(() => { this._panel = null; });
    }

    this._panel.title = detail.name || 'Detail';
    this._panel.webview.html = this._renderDetail(detail);
  }

  private _renderDetail(detail: any): string {
    const name = detail.name || detail.id || 'Unknown';
    const kind = detail.kind || '';
    const desc = detail.description || '';

    let sections = '';
    for (const section of (detail.sections || [])) {
      sections += `<h3>${section.title}</h3>`;

      if (section.kind === 'Table' && section.columns && section.rows) {
        sections += '<table border="1" cellpadding="4"><thead><tr>';
        sections += section.columns.map((c: string) => `<th>${c}</th>`).join('');
        sections += '</tr></thead><tbody>';
        for (const row of section.rows) {
          sections += '<tr>' + row.map((cell: string) => `<td>${cell ?? ''}</td>`).join('') + '</tr>';
        }
        sections += '</tbody></table>';
      } else if (section.kind === 'List' && section.items) {
        sections += '<ul>' + section.items.map((i: string) => `<li>${i}</li>`).join('') + '</ul>';
      } else if (section.kind === 'Text' && section.content) {
        sections += `<p>${section.content}</p>`;
      } else if (section.kind === 'Code' && section.content) {
        sections += `<pre><code>${section.content}</code></pre>`;
      }
    }

    return `<!DOCTYPE html>
    <html>
    <head><style>
      body { font-family: var(--vscode-font-family); padding: 16px; }
      table { border-collapse: collapse; width: 100%; margin: 8px 0; }
      th { background: var(--vscode-editor-background); text-align: left; }
    </style></head>
    <body>
      <h2>${name} <small>${kind}</small></h2>
      ${desc ? `<p>${desc}</p>` : ''}
      ${sections}
    </body>
    </html>`;
  }
}
