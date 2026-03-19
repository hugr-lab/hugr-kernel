/**
 * WebviewPanel for type and directive detail views in VS Code.
 *
 * Renders full type information with fields table, type links,
 * and metadata badges. Ported from JupyterLab detailModal.ts.
 */
import * as vscode from 'vscode';
import { HugrClient } from './hugrClient';
import { kindIconSvg, kindColor, hugrTypeColor, kindLabel, hugrTypeLabel } from './icons';

// ---------------------------------------------------------------------------
// Introspection queries
// ---------------------------------------------------------------------------

function typeDetailQuery(typeName: string): string {
  return `{
  __type(name: ${JSON.stringify(typeName)}) {
    name kind description hugr_type catalog module
    fields {
      name description hugr_type catalog
      type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
      args {
        name description defaultValue
        type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
      }
    }
    inputFields {
      name description defaultValue
      type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
    }
    enumValues { name description }
    interfaces { name }
    possibleTypes { name }
  }
}`;
}

const DIRECTIVES_QUERY = `{
  __schema {
    directives {
      name description isRepeatable locations
      args {
        name description defaultValue
        type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Type unwrapping
// ---------------------------------------------------------------------------

function resolveTypeName(typeRef: any): string {
  if (!typeRef) return '';
  if (typeRef.kind === 'NON_NULL') return resolveTypeName(typeRef.ofType) + '!';
  if (typeRef.kind === 'LIST') return '[' + resolveTypeName(typeRef.ofType) + ']';
  return typeRef.name || '';
}

function baseTypeName(typeRef: any): string {
  if (!typeRef) return '';
  if (typeRef.name) return typeRef.name;
  return baseTypeName(typeRef.ofType);
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Detail Panel
// ---------------------------------------------------------------------------

let _panel: vscode.WebviewPanel | null = null;
let _currentClient: HugrClient | null = null;
let _history: string[] = [];
let _loadVersion = 0;
/** The current type name being displayed (without @ prefix). */
let _currentTypeName = '';

function _ensurePanel(title: string): void {
  if (_panel) return;

  _panel = vscode.window.createWebviewPanel(
    'hugrTypeDetail',
    title,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel.onDidDispose(() => {
    _panel = null;
    _history = [];
    _currentTypeName = '';
  });

  _panel.webview.onDidReceiveMessage((msg) => {
    if (msg.command === 'showType' && msg.typeName && _currentClient) {
      showTypeDetail(msg.typeName, _currentClient);
    }
    if (msg.command === 'goBack' && _currentClient) {
      if (_history.length > 0) {
        const prev = _history.pop()!;
        showTypeDetail(prev, _currentClient, false);
      }
    }
  });
}

export function showTypeDetail(
  typeName: string,
  client: HugrClient,
  addToHistory = true
): void {
  _currentClient = client;
  _ensurePanel(typeName);

  // Track history using actual type name (not panel title)
  if (addToHistory && _currentTypeName && _currentTypeName !== typeName) {
    _history.push(_currentTypeName);
  }

  _currentTypeName = typeName;
  _panel!.title = typeName;
  _panel!.webview.html = loadingHtml(typeName, _history.length > 0);

  const version = ++_loadVersion;
  loadTypeDetail(typeName, client).then(html => {
    if (_panel && version === _loadVersion) {
      _panel.webview.html = html;
    }
  });
}

export function showDirectiveDetail(
  directiveName: string,
  client: HugrClient
): void {
  _currentClient = client;
  _history = [];
  _currentTypeName = '';
  const displayName = directiveName.startsWith('@') ? directiveName : `@${directiveName}`;

  _ensurePanel(displayName);

  _panel!.title = displayName;
  _panel!.webview.html = loadingHtml(displayName, false);

  const version = ++_loadVersion;
  loadDirectiveDetail(directiveName, client).then(html => {
    if (_panel && version === _loadVersion) {
      _panel.webview.html = html;
    }
  });
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadTypeDetail(typeName: string, client: HugrClient): Promise<string> {
  try {
    const res = await client.query(typeDetailQuery(typeName));
    const typeData = res.data?.__type;
    if (!typeData) {
      return errorHtml(`Type "${esc(typeName)}" not found.`);
    }
    return renderTypeHtml(typeData);
  } catch (err: any) {
    return errorHtml(`Error loading type: ${esc(String(err?.message ?? err))}`);
  }
}

async function loadDirectiveDetail(directiveName: string, client: HugrClient): Promise<string> {
  const lookupName = directiveName.startsWith('@') ? directiveName.slice(1) : directiveName;

  try {
    const res = await client.query(DIRECTIVES_QUERY);
    const directives: any[] = res.data?.__schema?.directives ?? [];
    const directive = directives.find((d: any) => d.name === lookupName);
    if (!directive) {
      return errorHtml(`Directive "@${esc(lookupName)}" not found.`);
    }
    return renderDirectiveHtml(directive);
  } catch (err: any) {
    return errorHtml(`Error loading directive: ${esc(String(err?.message ?? err))}`);
  }
}

// ---------------------------------------------------------------------------
// HTML rendering — Type
// ---------------------------------------------------------------------------

function renderTypeHtml(type: any): string {
  let body = '';

  // Metadata badges
  const badges: string[] = [];
  if (type.kind) {
    const color = kindColor(type.kind);
    badges.push(`<span class="badge" style="background:${color}22;color:${color}">${kindIconSvg(type.kind)} ${esc(type.kind)}</span>`);
  }
  if (type.hugr_type) {
    const color = hugrTypeColor(type.hugr_type);
    badges.push(`<span class="badge" style="background:${color}22;color:${color}">${esc(hugrTypeLabel(type.hugr_type))}</span>`);
  }
  if (type.catalog != null) {
    badges.push(`<span class="badge">catalog: ${esc(String(type.catalog))}</span>`);
  }
  if (type.module) {
    badges.push(`<span class="badge">module: ${esc(type.module)}</span>`);
  }
  if (badges.length) {
    body += `<div class="meta">${badges.join(' ')}</div>`;
  }

  // Description
  if (type.description) {
    body += `<p class="desc">${esc(type.description)}</p>`;
  }

  // Interfaces
  const interfaces: any[] = type.interfaces ?? [];
  if (interfaces.length) {
    body += `<h3>Implements (${interfaces.length})</h3>`;
    body += `<div class="type-links">${interfaces.map((i: any) => typeLink(i.name)).join(', ')}</div>`;
  }

  // Possible types (UNION/INTERFACE)
  const possibleTypes: any[] = type.possibleTypes ?? [];
  if (possibleTypes.length) {
    body += `<h3>Possible Types (${possibleTypes.length})</h3>`;
    body += `<div class="type-links">${possibleTypes.map((t: any) => typeLink(t.name)).join(', ')}</div>`;
  }

  // Fields (OBJECT)
  const fields: any[] = type.fields ?? [];
  if (fields.length) {
    body += `<h3>Fields (${fields.length})</h3>`;
    body += renderFieldsTable(fields);
  }

  // Input fields (INPUT_OBJECT)
  const inputFields: any[] = type.inputFields ?? [];
  if (inputFields.length) {
    body += `<h3>Fields (${inputFields.length})</h3>`;
    body += renderInputFieldsTable(inputFields);
  }

  // Enum values
  const enumValues: any[] = type.enumValues ?? [];
  if (enumValues.length) {
    body += `<h3>Values (${enumValues.length})</h3>`;
    body += '<ul class="enum-list">';
    for (const ev of enumValues) {
      const desc = ev.description ? ` — ${esc(ev.description)}` : '';
      body += `<li><strong>${esc(ev.name)}</strong>${desc}</li>`;
    }
    body += '</ul>';
  }

  return wrapHtml(esc(type.name), body, _history.length > 0);
}

// ---------------------------------------------------------------------------
// HTML rendering — Directive
// ---------------------------------------------------------------------------

function renderDirectiveHtml(directive: any): string {
  let body = '';

  // Badges
  const badges: string[] = [];
  if (directive.isRepeatable) {
    badges.push('<span class="badge">repeatable</span>');
  }
  if (badges.length) {
    body += `<div class="meta">${badges.join(' ')}</div>`;
  }

  // Description
  if (directive.description) {
    body += `<p class="desc">${esc(directive.description)}</p>`;
  }

  // Locations
  const locations: string[] = directive.locations ?? [];
  if (locations.length) {
    body += `<h3>Locations (${locations.length})</h3>`;
    body += '<ul class="enum-list">';
    for (const loc of locations) {
      body += `<li>${esc(loc)}</li>`;
    }
    body += '</ul>';
  }

  // Arguments
  const args: any[] = directive.args ?? [];
  if (args.length) {
    body += `<h3>Arguments (${args.length})</h3>`;
    body += '<table><thead><tr><th>Name</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody>';
    for (const arg of args) {
      const typeName = resolveTypeName(arg.type);
      const base = baseTypeName(arg.type);
      body += '<tr>';
      body += `<td><strong>${esc(arg.name)}</strong></td>`;
      body += `<td>${base ? typeLink(typeName, base) : esc(typeName)}</td>`;
      body += `<td>${arg.defaultValue != null ? esc(String(arg.defaultValue)) : ''}</td>`;
      body += `<td>${arg.description ? esc(arg.description) : ''}</td>`;
      body += '</tr>';
    }
    body += '</tbody></table>';
  }

  return wrapHtml(`@${esc(directive.name)}`, body, _history.length > 0);
}

// ---------------------------------------------------------------------------
// Fields table
// ---------------------------------------------------------------------------

function renderFieldsTable(fields: any[]): string {
  let html = '<table><thead><tr><th>#</th><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>';

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const typeName = resolveTypeName(f.type);
    const base = baseTypeName(f.type);
    const args: any[] = f.args ?? [];
    const subParts: string[] = [];
    if (f.hugr_type) subParts.push(esc(hugrTypeLabel(f.hugr_type)));
    if (f.catalog != null) subParts.push(`catalog: ${esc(String(f.catalog))}`);
    if (args.length) subParts.push(`${args.length} args`);
    const sub = subParts.length ? `<div class="sub">${subParts.join(' · ')}</div>` : '';

    html += '<tr>';
    html += `<td class="ordinal">${i + 1}</td>`;
    html += `<td><strong>${esc(f.name)}</strong>${sub}</td>`;
    html += `<td>${base ? typeLink(typeName, base) : esc(typeName)}</td>`;
    html += `<td>${f.description ? esc(f.description) : ''}</td>`;
    html += '</tr>';

    // Expandable args rows
    if (args.length) {
      html += `<tr class="args-row"><td></td><td colspan="3">`;
      html += '<table class="args-table"><thead><tr><th>Arg</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody>';
      for (const arg of args) {
        const argTypeName = resolveTypeName(arg.type);
        const argBase = baseTypeName(arg.type);
        html += '<tr>';
        html += `<td>${esc(arg.name)}</td>`;
        html += `<td>${argBase ? typeLink(argTypeName, argBase) : esc(argTypeName)}</td>`;
        html += `<td>${arg.defaultValue != null ? esc(String(arg.defaultValue)) : ''}</td>`;
        html += `<td>${arg.description ? esc(arg.description) : ''}</td>`;
        html += '</tr>';
      }
      html += '</tbody></table></td></tr>';
    }
  }

  html += '</tbody></table>';
  return html;
}

function renderInputFieldsTable(fields: any[]): string {
  let html = '<table><thead><tr><th>#</th><th>Name</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody>';

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const typeName = resolveTypeName(f.type);
    const base = baseTypeName(f.type);

    html += '<tr>';
    html += `<td class="ordinal">${i + 1}</td>`;
    html += `<td><strong>${esc(f.name)}</strong></td>`;
    html += `<td>${base ? typeLink(typeName, base) : esc(typeName)}</td>`;
    html += `<td>${f.defaultValue != null ? esc(String(f.defaultValue)) : ''}</td>`;
    html += `<td>${f.description ? esc(f.description) : ''}</td>`;
    html += '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function typeLink(displayName: string, navigateName?: string): string {
  const base = navigateName ?? displayName.replace(/[\[\]!]/g, '');
  return `<a href="#" class="type-link" data-type="${esc(base)}">${esc(displayName)}</a>`;
}

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

function loadingHtml(title: string, hasHistory = false): string {
  return wrapHtml(esc(title), '<p class="loading">Loading...</p>', hasHistory);
}

function errorHtml(message: string): string {
  return wrapHtml('Error', `<p class="error">${message}</p>`, false);
}

function wrapHtml(title: string, body: string, hasHistory = false): string {
  const backBtn = hasHistory
    ? `<a href="#" class="back-btn" id="backBtn">\u2190 Back</a>`
    : '';
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<style>
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
    line-height: 1.5;
  }
  h2 { margin: 0 0 12px; font-size: 1.4em; }
  h3 { margin: 16px 0 8px; font-size: 1.1em; color: var(--vscode-foreground); }
  .header-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .header-row h2 { margin: 0; }
  .back-btn {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 10px; border-radius: 4px; font-size: 11px;
    background: var(--vscode-button-secondaryBackground, #333);
    color: var(--vscode-button-secondaryForeground, #ccc);
    cursor: pointer; text-decoration: none; white-space: nowrap;
  }
  .back-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, #444);
  }
  .meta { margin-bottom: 12px; display: flex; flex-wrap: wrap; gap: 6px; }
  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 4px; font-size: 11px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .badge svg { width: 14px; height: 14px; vertical-align: middle; }
  .desc { margin: 8px 0; color: var(--vscode-descriptionForeground); }
  table {
    width: 100%; border-collapse: collapse; margin: 8px 0;
    font-size: 12px;
  }
  th, td {
    text-align: left; padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
  }
  th {
    background: var(--vscode-editorGroupHeader-tabsBackground);
    font-weight: 600; font-size: 11px;
    color: var(--vscode-foreground);
  }
  .ordinal { width: 30px; color: var(--vscode-descriptionForeground); font-size: 10px; }
  .sub { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .type-link {
    color: var(--vscode-textLink-foreground);
    cursor: pointer; text-decoration: none;
  }
  .type-link:hover { text-decoration: underline; }
  .type-links { display: flex; flex-wrap: wrap; gap: 8px; }
  .enum-list { margin: 4px 0; padding-left: 20px; }
  .enum-list li { margin: 2px 0; }
  .args-row td { padding-top: 0; }
  .args-table {
    width: 100%; margin: 4px 0 8px;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    border-radius: 4px;
  }
  .args-table th { font-size: 10px; }
  .args-table td { font-size: 11px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
  .loading { color: var(--vscode-descriptionForeground); font-style: italic; }
  .error { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
  <div class="header-row">${backBtn}<h2>${title}</h2></div>
  ${body}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.type-link');
      if (link) {
        e.preventDefault();
        const typeName = link.getAttribute('data-type');
        if (typeName) {
          vscode.postMessage({ command: 'showType', typeName });
        }
      }
      const backBtn = e.target.closest('.back-btn');
      if (backBtn) {
        e.preventDefault();
        vscode.postMessage({ command: 'goBack' });
      }
    });
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
