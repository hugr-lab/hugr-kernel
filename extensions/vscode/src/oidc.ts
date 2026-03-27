/**
 * OIDC Authorization Code + PKCE flow for VS Code.
 *
 * Spins up a temporary localhost HTTP server for the callback,
 * handles discovery, PKCE generation, token exchange, and proactive refresh.
 * Refresh tokens are stored in VS Code SecretStorage.
 * Access tokens are written to connections.json for kernel consumption.
 */
import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as url from 'url';

// Active sessions keyed by connection name
const _sessions: Map<string, LoginSession> = new Map();

interface OidcConfig {
  issuer: string;
  client_id: string;
}

interface OidcEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

class LoginSession {
  connectionName: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  tokenEndpoint: string;
  clientId: string;
  issuer: string;
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _secrets: vscode.SecretStorage;
  private _onSessionChange: () => void;
  tlsSkipVerify: boolean;

  constructor(
    connectionName: string,
    refreshToken: string,
    accessToken: string,
    expiresAt: number,
    tokenEndpoint: string,
    clientId: string,
    issuer: string,
    secrets: vscode.SecretStorage,
    onSessionChange: () => void,
    tlsSkipVerify = false,
  ) {
    this.connectionName = connectionName;
    this.refreshToken = refreshToken;
    this.accessToken = accessToken;
    this.expiresAt = expiresAt;
    this.tokenEndpoint = tokenEndpoint;
    this.clientId = clientId;
    this.issuer = issuer;
    this._secrets = secrets;
    this.tlsSkipVerify = tlsSkipVerify;
    this._onSessionChange = onSessionChange;
  }

  startRefreshTimer(): void {
    this.cancelRefreshTimer();
    const delay = Math.max((this.expiresAt - Date.now() / 1000) - 30, 1) * 1000;
    this._refreshTimer = setTimeout(() => this._doRefresh(), delay);
  }

  cancelRefreshTimer(): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  private async _doRefresh(): Promise<void> {
    this._refreshTimer = null;
    if (!this.refreshToken || !this.tokenEndpoint) return;

    try {
      const tokens = await postForm(this.tokenEndpoint, {
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId,
      }, 10000, this.tlsSkipVerify);

      this.accessToken = tokens.access_token;
      this.expiresAt = Date.now() / 1000 + (tokens.expires_in ?? 300);
      if (tokens.refresh_token) {
        this.refreshToken = tokens.refresh_token;
        await this._secrets.store(
          `hugr.oidc.refresh.${this.connectionName}`,
          this.refreshToken,
        );
      }

      writeTokensToConfig(this.connectionName, this.accessToken, this.expiresAt,
        this.tokenEndpoint ? {
          issuer: this.issuer,
          client_id: this.clientId,
          token_endpoint: this.tokenEndpoint,
        } : undefined);
      this._onSessionChange();
      this.startRefreshTimer();
    } catch (e: any) {
      console.error(`OIDC refresh failed for ${this.connectionName}:`, e);
      clearTokensFromConfig(this.connectionName);
      _sessions.delete(this.connectionName);
      this._onSessionChange();
    }
  }
}

// ── Config file helpers ──

function configPath(): string {
  return process.env.HUGR_CONFIG_PATH ||
    path.join(os.homedir(), '.hugr', 'connections.json');
}

function loadConfig(): { default?: string; connections: any[]; [key: string]: unknown } {
  const p = configPath();
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return { connections: [] };
  }
}

function saveConfig(cfg: any): void {
  const p = configPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

function writeTokensToConfig(
  connectionName: string,
  accessToken: string,
  expiresAt: number,
  oidcMeta?: { issuer: string; client_id: string; token_endpoint: string },
): void {
  const cfg = loadConfig();
  for (const conn of cfg.connections || []) {
    if (conn.name === connectionName) {
      conn.tokens = {
        access_token: accessToken,
        expires_at: Math.floor(expiresAt),
      };
      if (oidcMeta) {
        conn.oidc = oidcMeta;
      }
      break;
    }
  }
  saveConfig(cfg);
}

function clearTokensFromConfig(connectionName: string): void {
  const cfg = loadConfig();
  for (const conn of cfg.connections || []) {
    if (conn.name === connectionName) {
      delete conn.tokens;
      break;
    }
  }
  saveConfig(cfg);
}

// ── HTTP helpers ──

function httpGet(targetUrl: string, timeout = 5000, tlsSkipVerify = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(parsed, { timeout, rejectUnauthorized: !tlsSkipVerify }, (res) => {
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
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function postForm(targetUrl: string, params: Record<string, string>, timeout = 10000, tlsSkipVerify = false): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const parsed = new URL(targetUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      timeout,
      rejectUnauthorized: !tlsSkipVerify,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Token exchange failed: HTTP ${res.statusCode}: ${data}`));
        } else {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid token response: ${data.slice(0, 200)}`));
          }
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

// ── PKCE helpers ──

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');
  return { verifier, challenge };
}

// ── Discovery ──

export async function discoverAuthConfig(hugrUrl: string, tlsSkipVerify = false): Promise<OidcConfig | null> {
  let base = hugrUrl.replace(/\/+$/, '');
  // Strip /ipc or /graphql suffix to get server base
  if (base.endsWith('/ipc')) base = base.slice(0, -4);
  if (base.endsWith('/graphql')) base = base.slice(0, -8);

  try {
    const data = JSON.parse(await httpGet(`${base}/auth/config`, 5000, tlsSkipVerify));
    if (data.issuer) {
      return { issuer: data.issuer, client_id: data.client_id };
    }
    return null;
  } catch {
    return null;
  }
}

async function discoverOidcEndpoints(issuer: string, tlsSkipVerify = false): Promise<OidcEndpoints> {
  const data = JSON.parse(
    await httpGet(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, 5000, tlsSkipVerify),
  );
  return {
    authorization_endpoint: data.authorization_endpoint,
    token_endpoint: data.token_endpoint,
    end_session_endpoint: data.end_session_endpoint,
  };
}

// ── Login flow ──

export async function startLogin(
  connectionName: string,
  hugrUrl: string,
  secrets: vscode.SecretStorage,
  onSessionChange: () => void,
  tlsSkipVerify = false,
): Promise<void> {
  // Discover OIDC config from Hugr server
  const authConfig = await discoverAuthConfig(hugrUrl, tlsSkipVerify);
  if (!authConfig) {
    throw new Error('OIDC not configured on this Hugr server');
  }

  const { issuer, client_id } = authConfig;
  const oidcEndpoints = await discoverOidcEndpoints(issuer, tlsSkipVerify);
  const { verifier, challenge } = generatePkce();
  const state = crypto.randomBytes(24).toString('base64url');

  // Start local callback server on a fixed port (so Keycloak/EntraID redirect_uri is predictable)
  const CALLBACK_PORT = 18400;
  const { authCode, callbackPort } = await new Promise<{ authCode: string; callbackPort: number }>(
    (resolve, reject) => {
      let serverPort = CALLBACK_PORT;

      const server = http.createServer((req, res) => {
        const parsed = url.parse(req.url || '', true);
        if (parsed.pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const error = parsed.query.error as string | undefined;
        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h2>Login failed</h2><p>${error}</p></body></html>`);
          server.close();
          reject(new Error(`OIDC error: ${error}`));
          return;
        }

        const code = parsed.query.code as string;
        const returnedState = parsed.query.state as string;

        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Invalid state parameter</h2></body></html>');
          server.close();
          reject(new Error('Invalid state parameter'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body>' +
          '<h2>Login successful</h2>' +
          '<p>You can close this tab and return to VS Code.</p>' +
          '<script>window.close()</script>' +
          '</body></html>',
        );
        server.close();
        resolve({ authCode: code, callbackPort: serverPort });
      });

      // Listen on fixed port — wait for 'listening' before reading address
      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${CALLBACK_PORT} is already in use. Close any other login window and try again.`));
        } else {
          reject(err);
        }
      });
      server.listen(CALLBACK_PORT, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        serverPort = addr.port;

        // Timeout after 2 minutes
        const timeout = setTimeout(() => {
          server.close();
          reject(new Error('Login timed out'));
        }, 120000);

        server.on('close', () => clearTimeout(timeout));

        // Build and open authorization URL
        const redirectUri = `http://127.0.0.1:${serverPort}/callback`;
        const params = new URLSearchParams({
          response_type: 'code',
          client_id,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          scope: 'openid',
        });
        const authUrl = `${oidcEndpoints.authorization_endpoint}?${params.toString()}`;
        vscode.env.openExternal(vscode.Uri.parse(authUrl));
      });
    },
  );

  // Exchange code for tokens
  const redirectUri = `http://127.0.0.1:${callbackPort}/callback`;
  const tokens = await postForm(oidcEndpoints.token_endpoint, {
    grant_type: 'authorization_code',
    code: authCode,
    redirect_uri: redirectUri,
    client_id,
    code_verifier: verifier,
  }, 10000, tlsSkipVerify);

  const accessToken = tokens.access_token;
  const expiresAt = Date.now() / 1000 + (tokens.expires_in ?? 300);
  const refreshToken = tokens.refresh_token ?? '';

  // Cancel old session
  const old = _sessions.get(connectionName);
  if (old) {
    old.cancelRefreshTimer();
  }

  // Write access token + OIDC metadata to connections.json
  writeTokensToConfig(connectionName, accessToken, expiresAt, {
    issuer,
    client_id,
    token_endpoint: oidcEndpoints.token_endpoint,
  });

  // Store refresh token in SecretStorage
  if (refreshToken) {
    await secrets.store(`hugr.oidc.refresh.${connectionName}`, refreshToken);
  }

  // Create session
  const session = new LoginSession(
    connectionName,
    refreshToken,
    accessToken,
    expiresAt,
    oidcEndpoints.token_endpoint,
    client_id,
    issuer,
    secrets,
    onSessionChange,
    tlsSkipVerify,
  );
  _sessions.set(connectionName, session);

  if (refreshToken) {
    session.startRefreshTimer();
  }

  onSessionChange();
}

// ── Logout ──

export async function logout(
  connectionName: string,
  secrets: vscode.SecretStorage,
): Promise<string | null> {
  const session = _sessions.get(connectionName);
  let endSessionUrl: string | null = null;

  if (session) {
    session.cancelRefreshTimer();
    _sessions.delete(connectionName);

    if (session.issuer) {
      try {
        const oidcEndpoints = await discoverOidcEndpoints(session.issuer);
        if (oidcEndpoints.end_session_endpoint) {
          const params = new URLSearchParams({ client_id: session.clientId });
          endSessionUrl = `${oidcEndpoints.end_session_endpoint}?${params.toString()}`;
        } else {
          console.warn(`OIDC logout: no end_session_endpoint for issuer ${session.issuer}`);
        }
      } catch (e) {
        console.error(`OIDC logout: discovery failed for ${session.issuer}:`, e);
      }
    } else {
      console.warn(`OIDC logout: no issuer stored for ${connectionName}`);
    }
  } else {
    console.warn(`OIDC logout: no active session for ${connectionName}`);
  }

  clearTokensFromConfig(connectionName);
  await secrets.delete(`hugr.oidc.refresh.${connectionName}`);

  return endSessionUrl;
}

// ── Session queries ──

export function isAuthenticated(connectionName: string): boolean {
  const session = _sessions.get(connectionName);
  return !!session && session.expiresAt > Date.now() / 1000;
}

export function getToken(connectionName: string): { access_token: string; expires_at: number } | null {
  const session = _sessions.get(connectionName);
  if (!session) return null;

  // Force refresh if near expiry
  if (session.expiresAt - Date.now() / 1000 < 30 && session.refreshToken) {
    // Refresh is async, return current token anyway
    return null;
  }

  return {
    access_token: session.accessToken,
    expires_at: Math.floor(session.expiresAt),
  };
}

// ── Restore sessions on startup ──

export async function restoreSessionsOnStartup(
  secrets: vscode.SecretStorage,
  onSessionChange: () => void,
): Promise<void> {
  const cfg = loadConfig();
  for (const conn of cfg.connections || []) {
    if (conn.auth_type !== 'browser') continue;

    const tokens = conn.tokens;
    if (!tokens?.access_token) continue;

    const expiresAt = tokens.expires_at ?? 0;
    const oidcMeta = conn.oidc as { issuer?: string; client_id?: string; token_endpoint?: string } | undefined;
    const issuer = oidcMeta?.issuer ?? '';
    const clientId = oidcMeta?.client_id ?? '';
    const tokenEndpoint = oidcMeta?.token_endpoint ?? '';

    if (expiresAt <= Date.now() / 1000) {
      // Expired — try to refresh if we have stored refresh token + endpoint info
      const refreshToken = await secrets.get(`hugr.oidc.refresh.${conn.name}`);
      if (!refreshToken || !tokenEndpoint) {
        delete conn.tokens;
        continue;
      }
      // Will try refresh below
      delete conn.tokens;
      continue;
    }

    // Token still valid — create session with OIDC metadata for logout/refresh
    const refreshToken = await secrets.get(`hugr.oidc.refresh.${conn.name}`) ?? '';
    const session = new LoginSession(
      conn.name,
      refreshToken,
      tokens.access_token,
      expiresAt,
      tokenEndpoint,
      clientId,
      issuer,
      secrets,
      onSessionChange,
      conn.tls_skip_verify === true,
    );
    _sessions.set(conn.name, session);
    if (refreshToken && tokenEndpoint) {
      session.startRefreshTimer();
    }
  }

  saveConfig(cfg);
  onSessionChange();
}

// ── Cleanup ──

export function disposeAll(): void {
  for (const session of _sessions.values()) {
    session.cancelRefreshTimer();
  }
  _sessions.clear();
}
