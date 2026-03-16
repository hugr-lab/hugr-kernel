/**
 * Connection Manager for VS Code — reads/writes ~/.hugr/connections.json.
 *
 * File format:
 * {
 *   "default": "local",
 *   "connections": [
 *     { "name": "local", "url": "http://localhost:15004/graphql" },
 *     { "name": "prod", "url": "https://prod.example.com/graphql" }
 *   ]
 * }
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';

interface ConnectionEntry {
  name: string;
  url: string;
  auth_type?: string;
  [key: string]: unknown; // preserve extra fields (created_at, etc.)
}

interface ConnectionsFile {
  default?: string;
  connections: ConnectionEntry[];
  [key: string]: unknown; // preserve extra fields (kernels, etc.)
}

export class ConnectionTreeProvider implements vscode.TreeDataProvider<ConnectionEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ConnectionEntry | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _connections: ConnectionEntry[] = [];
  private _defaultName = '';
  private _watcher: fs.FSWatcher | null = null;
  private _extraFields: Record<string, unknown> = {}; // preserve kernels, etc.

  constructor() {
    this._load();
    this._watchFile();
  }

  dispose(): void {
    this._watcher?.close();
  }

  refresh(): void {
    this._load();
  }

  getTreeItem(element: ConnectionEntry): vscode.TreeItem {
    const isDefault = element.name === this._defaultName;
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    const authLabel = element.auth_type && element.auth_type !== 'public' ? ` [${element.auth_type}]` : '';
    item.description = element.url + authLabel;
    item.tooltip = `${element.name}\n${element.url}${authLabel}${isDefault ? '\n★ default' : ''}`;
    item.iconPath = new vscode.ThemeIcon(isDefault ? 'star-full' : 'plug');
    item.contextValue = 'connection';
    return item;
  }

  async getChildren(element?: ConnectionEntry): Promise<ConnectionEntry[]> {
    if (element) return [];
    return this._connections;
  }

  // --- Commands ---

  async addConnection(): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: 'Connection name',
      placeHolder: 'e.g. local',
      validateInput: (v) => {
        if (!v.trim()) return 'Name is required';
        if (this._connections.some(c => c.name === v.trim())) return 'Name already exists';
        return undefined;
      },
    });
    if (!name) return;

    const url = await vscode.window.showInputBox({
      prompt: 'Hugr GraphQL endpoint URL',
      placeHolder: 'http://localhost:15004/graphql',
      validateInput: (v) => {
        if (!v.trim()) return 'URL is required';
        try { new URL(v.trim()); } catch { return 'Invalid URL'; }
        return undefined;
      },
    });
    if (!url) return;

    const entry: ConnectionEntry = { name: name.trim(), url: url.trim() };
    this._connections.push(entry);
    if (this._connections.length === 1) {
      this._defaultName = entry.name;
    }
    this._save();
  }

  async editConnection(entry: ConnectionEntry): Promise<void> {
    const url = await vscode.window.showInputBox({
      prompt: `Edit URL for "${entry.name}"`,
      value: entry.url,
      validateInput: (v) => {
        if (!v.trim()) return 'URL is required';
        try { new URL(v.trim()); } catch { return 'Invalid URL'; }
        return undefined;
      },
    });
    if (!url) return;

    const conn = this._connections.find(c => c.name === entry.name);
    if (conn) {
      conn.url = url.trim();
      this._save();
    }
  }

  async removeConnection(entry: ConnectionEntry): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      `Remove connection "${entry.name}"?`, { modal: true }, 'Remove',
    );
    if (answer !== 'Remove') return;

    this._connections = this._connections.filter(c => c.name !== entry.name);
    if (this._defaultName === entry.name) {
      this._defaultName = this._connections.length > 0 ? this._connections[0].name : '';
    }
    this._save();
  }

  async setDefault(entry: ConnectionEntry): Promise<void> {
    this._defaultName = entry.name;
    this._save();
    vscode.window.showInformationMessage(`Default connection: ${entry.name}`);
  }

  async testConnection(entry: ConnectionEntry): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Testing ${entry.name}...` },
      async () => {
        try {
          // Same query as query-engine/client Ping() — sent to IPC endpoint
          const body = JSON.stringify({
            query: '{ function { core { info { version } } } }',
          });
          const raw = await httpPost(entry.url, body);
          const version = parseIpcVersion(raw);
          if (version) {
            vscode.window.showInformationMessage(`${entry.name}: Hugr v${version}`);
          } else {
            vscode.window.showInformationMessage(`${entry.name}: connected`);
          }
        } catch (e: any) {
          vscode.window.showErrorMessage(`${entry.name}: ${e.message || e}`);
        }
      },
    );
  }

  // --- File I/O ---

  private _configPath(): string {
    return process.env.HUGR_CONFIG_PATH ||
      path.join(os.homedir(), '.hugr', 'connections.json');
  }

  private _load(): void {
    const configPath = this._configPath();
    try {
      const data = fs.readFileSync(configPath, 'utf-8');
      const cfg: ConnectionsFile = JSON.parse(data);
      this._connections = cfg.connections || [];
      this._defaultName = cfg.default || (this._connections.length > 0 ? this._connections[0].name : '');
      // Preserve fields we don't manage (kernels, etc.)
      const { default: _d, connections: _c, ...rest } = cfg;
      this._extraFields = rest;
    } catch {
      this._connections = [];
      this._defaultName = '';
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  private _save(): void {
    const configPath = this._configPath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const cfg: ConnectionsFile = {
      default: this._defaultName,
      connections: this._connections,
      ...this._extraFields,
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
    this._onDidChangeTreeData.fire(undefined);
  }

  private _watchFile(): void {
    const configPath = this._configPath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { return; }
    }
    try {
      this._watcher = fs.watch(dir, (_, filename) => {
        if (filename === path.basename(configPath)) {
          this._load();
        }
      });
    } catch {
      // watch not supported on some platforms
    }
  }
}

/**
 * POST to the IPC endpoint and return raw multipart body.
 */
function httpPost(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Connection timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Parse Hugr IPC multipart response to extract version from Ping query.
 * Format: --HUGR\r\nheaders\r\n\r\nbody\r\n--HUGR--
 * Looks for JSON part with X-Hugr-Path containing "info" and extracts version.
 */
function parseIpcVersion(raw: string): string | null {
  // Split by boundary
  const parts = raw.split(/--HUGR\r?\n/);
  for (const part of parts) {
    if (!part.trim() || part.startsWith('--')) continue;
    // Split headers from body
    const sepIdx = part.indexOf('\n\n');
    const sepIdx2 = part.indexOf('\r\n\r\n');
    const idx = sepIdx2 >= 0 ? sepIdx2 : sepIdx;
    if (idx < 0) continue;
    const body = part.slice(idx).trim().replace(/--HUGR--$/, '').trim();
    if (!body) continue;
    try {
      const parsed = JSON.parse(body);
      if (parsed?.version) return parsed.version;
    } catch {
      // not JSON, skip
    }
  }
  return null;
}
