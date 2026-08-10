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

  /** In-flight refresh, so a burst of requests near expiry refreshes once. */
  private _refreshing: Promise<boolean> | null = null;
  /** Consecutive transient refresh failures; resets on success. */
  private _retryCount = 0;

  /**
   * Whether this session is still the REGISTERED one. Logout removes the
   * session from the registry but cannot cancel a refresh already in flight —
   * a detached session must never persist tokens or schedule retries, or a
   * completed refresh resurrects exactly what logout wiped.
   */
  private get _active(): boolean {
    return _sessions.get(this.connectionName) === this;
  }

  startRefreshTimer(): void {
    this.cancelRefreshTimer();
    const delay = Math.max((this.expiresAt - Date.now() / 1000) - 30, 1) * 1000;
    this._refreshTimer = setTimeout(() => void this.refreshNow(), delay);
  }

  cancelRefreshTimer(): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /**
   * Refresh the access token, deduplicated: the proactive timer and any number
   * of concurrent per-request callers share one round-trip.
   */
  refreshNow(): Promise<boolean> {
    if (!this._refreshing) {
      this._refreshing = this._doRefresh().finally(() => {
        this._refreshing = null;
      });
    }
    return this._refreshing;
  }

  private async _doRefresh(): Promise<boolean> {
    this.cancelRefreshTimer();
    if (!this._active || !this.refreshToken || !this.tokenEndpoint) return false;

    try {
      const tokens = await postForm(this.tokenEndpoint, {
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId,
      }, 10000, this.tlsSkipVerify);

      // Logout may have detached this session during the round-trip.
      if (!this._active) return false;

      this._retryCount = 0;
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
      return true;
    } catch (e: any) {
      console.error(`OIDC refresh failed for ${this.connectionName}:`, e);
      if (!this._active) return false;
      // Only a REJECTED grant ends the session — the refresh token is
      // expired, revoked, or wrong, and only a new login can fix that. That
      // means 400/401 from the TOKEN ENDPOINT specifically: a 429 rate limit
      // or a 408 from a proxy is transient and must not log the user out.
      // Transient failures retry — but not forever: after ~10 minutes of
      // failures the stale session only masks the outage, so it ends too.
      const msg = String(e?.message ?? e);
      const rejected =
        /invalid_grant|invalid_client/.test(msg) ||
        /^Token exchange failed: HTTP 40[01]:/.test(msg);
      if (rejected || ++this._retryCount > 20) {
        clearTokensFromConfig(this.connectionName);
        _sessions.delete(this.connectionName);
        this._onSessionChange();
      } else {
        this._refreshTimer = setTimeout(() => void this.refreshNow(), 30000);
      }
      return false;
    }
  }
}

// ── Config file helpers ──

function configPath(): string {
  return process.env.HUGR_CONFIG_PATH ||
    path.join(os.homedir(), '.hugr', 'connections.json');
}

/**
 * Read the shared config. A MISSING file is a real empty config; an
 * UNPARSEABLE one is somebody else's write in flight (several processes share
 * this file: this extension, the kernel, the JupyterLab service) and is
 * returned as null — a caller that "repaired" it to `{connections: []}` and
 * saved would delete every connection the user has.
 */
function loadConfig(): { default?: string; connections: any[]; [key: string]: unknown } | null {
  const p = configPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    return { connections: [] };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Write-to-temp + rename, so no other process ever reads a torn file. */
function saveConfig(cfg: any): void {
  const p = configPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = path.join(dir, `.connections.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, p);
}

function writeTokensToConfig(
  connectionName: string,
  accessToken: string,
  expiresAt: number,
  oidcMeta?: { issuer: string; client_id: string; token_endpoint: string },
): void {
  const cfg = loadConfig();
  if (!cfg) {
    console.warn('hugr: connections.json unreadable, token not persisted');
    return;
  }
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
  if (!cfg) {
    console.warn('hugr: connections.json unreadable, tokens not cleared');
    return;
  }
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

/**
 * The token to put on a request RIGHT NOW: fresh as-is, or refreshed first.
 *
 * This is the correctness path — the proactive timer is only an optimization
 * (it can oversleep, or lose one round to a network hiccup), so a request
 * near expiry refreshes inline and waits. Concurrent callers share one
 * refresh via refreshNow().
 */
export async function getValidToken(
  connectionName: string,
): Promise<{ access_token: string; expires_at: number } | null> {
  let session = _sessions.get(connectionName);
  if (!session) return null;

  if (session.expiresAt - Date.now() / 1000 < 30 && session.refreshToken) {
    await session.refreshNow();
    // A rejected grant deletes the session; a transient failure keeps it and
    // the stale token below is still the best answer we have — the server's
    // 401 says more than a silent missing header would.
    session = _sessions.get(connectionName);
    if (!session) return null;
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
  if (!cfg) {
    // Mid-write or corrupt — touching it now could only make it worse.
    return;
  }
  let cfgChanged = false;
  for (const conn of cfg.connections || []) {
    if (conn.auth_type !== 'browser') continue;

    const tokens = conn.tokens;
    if (!tokens?.access_token) continue;

    const expiresAt = tokens.expires_at ?? 0;
    const oidcMeta = conn.oidc as { issuer?: string; client_id?: string; token_endpoint?: string } | undefined;
    const issuer = oidcMeta?.issuer ?? '';
    const clientId = oidcMeta?.client_id ?? '';
    const tokenEndpoint = oidcMeta?.token_endpoint ?? '';
    const refreshToken = await secrets.get(`hugr.oidc.refresh.${conn.name}`) ?? '';
    const expired = expiresAt <= Date.now() / 1000;

    if (expired && (!refreshToken || !tokenEndpoint)) {
      // Nothing to refresh with — this login is over.
      delete conn.tokens;
      cfgChanged = true;
      continue;
    }

    // Live token, or an expired one we can refresh: either way the session
    // exists — an access token that outlives a VS Code restart is the
    // exception, not the rule, so an expired one on startup must refresh
    // rather than log the user out.
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
      if (expired) {
        void session.refreshNow();
      } else {
        session.startRefreshTimer();
      }
    }
  }

  if (cfgChanged) {
    saveConfig(cfg);
  }
  onSessionChange();
}

// ── Cleanup ──

export function disposeAll(): void {
  for (const session of _sessions.values()) {
    session.cancelRefreshTimer();
  }
  _sessions.clear();
}
