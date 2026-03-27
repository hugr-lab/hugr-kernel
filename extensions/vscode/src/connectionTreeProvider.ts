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
import { HugrClient } from './explorer/hugrClient';
import * as oidc from './oidc';

export interface ConnectionEntry {
  name: string;
  url: string;
  auth_type?: string;
  auth_credential?: string;
  tls_skip_verify?: boolean;
  tokens?: { access_token: string; expires_at: number };
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

  private _onDidChangeDefault = new vscode.EventEmitter<ConnectionEntry | undefined>();
  readonly onDidChangeDefault = this._onDidChangeDefault.event;

  private _connections: ConnectionEntry[] = [];
  private _defaultName = '';
  private _prevDefaultName = '';
  private _watcher: fs.FSWatcher | null = null;
  private _extraFields: Record<string, unknown> = {}; // preserve kernels, etc.
  private _secrets: vscode.SecretStorage;

  constructor(secrets: vscode.SecretStorage) {
    this._secrets = secrets;
    this._load();
    this._watchFile();
    // Restore OIDC sessions from connections.json
    oidc.restoreSessionsOnStartup(secrets, () => this._fireTreeChange());
  }

  dispose(): void {
    this._watcher?.close();
    this._onDidChangeDefault.dispose();
    oidc.disposeAll();
  }

  refresh(): void {
    this._load();
  }

  /**
   * Returns the current default connection entry, or undefined if none.
   */
  getDefaultConnection(): ConnectionEntry | undefined {
    return this._connections.find(c => c.name === this._defaultName);
  }

  /**
   * Creates a HugrClient for the given connection (or the default).
   */
  createClient(connectionName?: string): HugrClient | null {
    const name = connectionName ?? this._defaultName;
    const conn = this._connections.find(c => c.name === name);
    if (!conn) return null;

    const tlsSkipVerify = conn.tls_skip_verify ?? false;

    if (conn.auth_type === 'browser') {
      // For browser auth, read token from OIDC session or connections.json
      const tokenData = oidc.getToken(name);
      if (tokenData) {
        return new HugrClient({
          url: conn.url,
          authType: 'bearer',
          token: tokenData.access_token,
          tlsSkipVerify,
        });
      }
      // Fallback: read from connections.json tokens field
      if (conn.tokens?.access_token) {
        return new HugrClient({
          url: conn.url,
          authType: 'bearer',
          token: conn.tokens.access_token,
          tlsSkipVerify,
        });
      }
      // Not authenticated — return public client (queries will fail with auth error)
      return new HugrClient({ url: conn.url, authType: 'public', tlsSkipVerify });
    }

    return new HugrClient({
      url: conn.url,
      authType: (conn.auth_type as any) ?? 'public',
      apiKey: conn.auth_type === 'api_key' ? (conn.auth_credential as string) : undefined,
      token: conn.auth_type === 'bearer' ? (conn.auth_credential as string) : undefined,
      tlsSkipVerify,
    });
  }

  getTreeItem(element: ConnectionEntry): vscode.TreeItem {
    const isDefault = element.name === this._defaultName;
    const isBrowser = element.auth_type === 'browser';
    const authenticated = isBrowser ? oidc.isAuthenticated(element.name) : false;

    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);

    const authLabel = element.auth_type && element.auth_type !== 'public' ? ` [${element.auth_type}]` : '';
    const authStatus = isBrowser ? (authenticated ? ' $(pass-filled)' : ' $(error)') : '';

    item.description = element.url + authLabel;
    item.tooltip = `${element.name}\n${element.url}${authLabel}${isDefault ? '\n★ default' : ''}${isBrowser ? (authenticated ? '\n✓ authenticated' : '\n✗ not authenticated') : ''}`;

    if (isBrowser) {
      item.iconPath = new vscode.ThemeIcon(
        isDefault ? 'star-full' : (authenticated ? 'pass-filled' : 'error'),
        authenticated
          ? new vscode.ThemeColor('testing.iconPassed')
          : new vscode.ThemeColor('testing.iconFailed'),
      );
    } else {
      item.iconPath = new vscode.ThemeIcon(isDefault ? 'star-full' : 'plug');
    }

    // Set contextValue to control menu visibility
    if (isBrowser) {
      item.contextValue = authenticated ? 'connection_browser_auth' : 'connection_browser_noauth';
    } else {
      item.contextValue = 'connection';
    }

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

    // Auto-discover OIDC
    let detectedOidc = false;
    try {
      const authConfig = await oidc.discoverAuthConfig(url.trim());
      if (authConfig) {
        detectedOidc = true;
      }
    } catch { /* ignore */ }

    // Ask for auth type
    const authOptions = [
      { label: 'Public', value: 'public', description: 'No authentication' },
      { label: 'API Key', value: 'api_key', description: 'X-Api-Key header' },
      { label: 'Bearer Token', value: 'bearer', description: 'Authorization: Bearer header' },
      { label: 'Browser (OIDC)', value: 'browser', description: detectedOidc ? 'OIDC detected on this server' : 'OIDC login via browser' },
    ];

    const selectedAuth = await vscode.window.showQuickPick(authOptions, {
      placeHolder: detectedOidc ? 'Auth type (OIDC detected)' : 'Auth type',
    });
    if (!selectedAuth) return;

    const entry: ConnectionEntry = {
      name: name.trim(),
      url: url.trim(),
      auth_type: selectedAuth.value,
    };

    // Ask about TLS skip verify if URL is HTTPS
    if (url.trim().startsWith('https://')) {
      const tlsPick = await vscode.window.showQuickPick(
        [
          { label: 'Verify certificates', value: false, description: 'Default — verify TLS certificates' },
          { label: 'Skip verification', value: true, description: 'For self-signed certificates' },
        ],
        { placeHolder: 'TLS certificate verification' },
      );
      if (tlsPick?.value) {
        entry.tls_skip_verify = true;
      }
    }

    // Ask for credential if needed
    if (selectedAuth.value === 'api_key') {
      const key = await vscode.window.showInputBox({
        prompt: 'API Key',
        password: true,
        placeHolder: 'sk-...',
      });
      if (!key) return;
      entry.auth_credential = key;
    } else if (selectedAuth.value === 'bearer') {
      const token = await vscode.window.showInputBox({
        prompt: 'Bearer Token',
        password: true,
        placeHolder: 'eyJ...',
      });
      if (!token) return;
      entry.auth_credential = token;
    }

    this._connections.push(entry);
    if (this._connections.length === 1) {
      this._defaultName = entry.name;
    }
    this._save();

    // For browser connections, start login flow
    if (selectedAuth.value === 'browser') {
      try {
        await oidc.startLogin(entry.name, entry.url, this._secrets, () => this._fireTreeChange(), entry.tls_skip_verify);
        vscode.window.showInformationMessage(`${entry.name}: logged in`);
        this._load();
      } catch (e: any) {
        vscode.window.showWarningMessage(`Saved, but login failed: ${e.message}`);
      }
    }
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

      // Ask about TLS skip verify if URL is HTTPS
      if (url.trim().startsWith('https://')) {
        const tlsPick = await vscode.window.showQuickPick(
          [
            { label: 'Verify certificates', value: false, description: 'Default — verify TLS certificates' },
            { label: 'Skip verification', value: true, description: 'For self-signed certificates' },
          ],
          { placeHolder: `TLS verification (currently: ${conn.tls_skip_verify ? 'skipped' : 'verified'})` },
        );
        if (tlsPick !== undefined) {
          conn.tls_skip_verify = tlsPick.value || undefined;
        }
      }

      this._save();
    }
  }

  async removeConnection(entry: ConnectionEntry): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      `Remove connection "${entry.name}"?`, { modal: true }, 'Remove',
    );
    if (answer !== 'Remove') return;

    // Logout if browser connection
    if (entry.auth_type === 'browser') {
      await oidc.logout(entry.name, this._secrets);
    }

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
    if (entry.auth_type === 'browser' && !oidc.isAuthenticated(entry.name)) {
      vscode.window.showWarningMessage(`${entry.name}: not authenticated — please login first`);
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Testing ${entry.name}...` },
      async () => {
        try {
          const body = JSON.stringify({
            query: '{ function { core { info { version } } } }',
          });
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };

          // Add auth headers
          if (entry.auth_type === 'api_key' && entry.auth_credential) {
            headers['X-Api-Key'] = entry.auth_credential;
          } else if (entry.auth_type === 'bearer' && entry.auth_credential) {
            headers['Authorization'] = `Bearer ${entry.auth_credential}`;
          } else if (entry.auth_type === 'browser') {
            const tokenData = oidc.getToken(entry.name);
            if (tokenData) {
              headers['Authorization'] = `Bearer ${tokenData.access_token}`;
            }
          }

          const raw = await httpPost(entry.url, body, headers, entry.tls_skip_verify);
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

  async loginConnection(entry: ConnectionEntry): Promise<void> {
    if (entry.auth_type !== 'browser') {
      vscode.window.showWarningMessage('Login is only available for browser (OIDC) connections');
      return;
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Logging in to ${entry.name}...`, cancellable: false },
        async () => {
          await oidc.startLogin(entry.name, entry.url, this._secrets, () => this._fireTreeChange(), entry.tls_skip_verify);
        },
      );
      vscode.window.showInformationMessage(`${entry.name}: logged in`);
      this._load();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Login failed: ${e.message}`);
    }
  }

  async logoutConnection(entry: ConnectionEntry): Promise<void> {
    if (entry.auth_type !== 'browser') return;

    const endSessionUrl = await oidc.logout(entry.name, this._secrets);
    if (endSessionUrl) {
      vscode.env.openExternal(vscode.Uri.parse(endSessionUrl));
    } else {
      console.warn('No end_session_url returned — IdP session not cleared');
    }
    vscode.window.showInformationMessage(`${entry.name}: logged out`);
    this._load();
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
    this._fireDefaultChangeIfNeeded();
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
    this._fireDefaultChangeIfNeeded();
  }

  private _fireTreeChange(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  private _fireDefaultChangeIfNeeded(): void {
    if (this._defaultName !== this._prevDefaultName) {
      this._prevDefaultName = this._defaultName;
      this._onDidChangeDefault.fire(this.getDefaultConnection());
    }
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
function httpPost(url: string, body: string, extraHeaders?: Record<string, string>, tlsSkipVerify = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...extraHeaders,
    };
    const req = mod.request(parsed, {
      method: 'POST',
      headers,
      timeout: 5000,
      rejectUnauthorized: !tlsSkipVerify,
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
