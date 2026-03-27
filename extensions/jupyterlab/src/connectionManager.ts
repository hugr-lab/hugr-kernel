/**
 * Connection Manager sidebar widget.
 */
import { Widget } from '@lumino/widgets';
import { LabIcon } from '@jupyterlab/ui-components';
import { ServerConnection } from '@jupyterlab/services';
import { escapeHtml } from './utils';
import { HugrClient } from './hugrClient';

const _serverSettings = ServerConnection.makeSettings();
const BASE_URL = _serverSettings.baseUrl + 'hugr';

export const hugrIcon = new LabIcon({
  name: '@hugr-lab/jupyterlab-graphql-ide:hugr-icon',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 315 315">' +
    '<circle cx="157.5" cy="157.5" r="157.5" fill="currentColor" opacity="0.25"/>' +
    '<circle cx="150" cy="113" r="75" fill="#1C7D78"/>' +
    '<path d="M166.924 118.934C179.528 121.854 191.162 127.984 200.697 136.729C210.231 145.475 217.341 156.538 221.336 168.843C225.33 181.149 226.074 194.279 223.494 206.957C220.913 219.635 215.098 231.43 206.611 241.195C198.125 250.961 187.256 258.365 175.062 262.689C162.868 267.012 149.763 268.107 137.02 265.868C124.278 263.629 112.331 258.132 102.341 249.911C92.3514 241.689 84.6582 231.023 80.0093 218.95L90.5079 214.907C94.4595 225.17 100.999 234.236 109.49 241.224C117.981 248.212 128.136 252.885 138.967 254.788C149.799 256.691 160.938 255.76 171.303 252.085C181.668 248.411 190.906 242.117 198.119 233.816C205.333 225.515 210.276 215.49 212.47 204.713C214.663 193.937 214.031 182.777 210.635 172.317C207.24 161.857 201.196 152.453 193.092 145.02C184.988 137.586 175.099 132.376 164.385 129.894L166.924 118.934Z" fill="currentColor"/>' +
    '<path d="M180 123C180 131.284 173.284 138 165 138C156.716 138 150 131.284 150 123C150 114.716 156.716 108 165 108C173.284 108 180 114.716 180 123Z" fill="currentColor"/>' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M206.451 162.38C203.046 155.89 198.533 150.011 193.092 145.02C187.908 140.264 181.992 136.419 175.598 133.615C172.884 136.325 169.138 138 165 138C156.716 138 150 131.284 150 123C150 114.716 156.716 108 165 108C173.284 108 180 114.716 180 123C180 123.087 179.999 123.174 179.998 123.26C187.565 126.563 194.565 131.105 200.697 136.729C205.774 141.386 210.164 146.701 213.761 152.51C211.593 156.001 209.146 159.302 206.451 162.38Z" fill="white"/>' +
    '</svg>',
});

// Inline SVG icons for buttons (16x16)
const ICON_PLAY = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
const ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const ICON_PLUS = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const ICON_STAR = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
const ICON_STAR_FILLED = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

function makeRequest(method: string, body?: any): RequestInit {
  const headers: Record<string, string> = {};
  if (body) {
    headers['Content-Type'] = 'application/json';
  }
  return {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
}

/** fetch via ServerConnection — handles JupyterHub token auth automatically */
function hugrFetch(url: string, init?: RequestInit): Promise<Response> {
  return ServerConnection.makeRequest(url, init ?? {}, _serverSettings);
}

const ICON_LOGIN = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>`;
const ICON_LOGOUT = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;

interface ConnectionInfo {
  name: string;
  url: string;
  auth_type: string;
  role: string | null;
  read_only: boolean;
  status: string;
  authenticated?: boolean;
  expires_at?: number;
  was_authenticated?: boolean;
}

export class ConnectionManagerWidget extends Widget {
  private _connections: ConnectionInfo[] = [];
  private _initialLoadDone = false;
  private _authMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private _previousAuthState: Map<string, boolean> = new Map();

  constructor() {
    super();
    this.id = 'hugr-connection-manager';
    this.addClass('hugr-connection-manager');
    this.title.icon = hugrIcon;
    this.title.caption = 'Hugr Connections';
    this.title.closable = true;
    this._render();
  }

  private _render(): void {
    this.node.innerHTML = `
      <div class="hugr-cm-container">
        <div class="hugr-cm-header">
          <span class="hugr-cm-title">Connections</span>
          <button id="hugr-btn-add" class="hugr-cm-icon-btn" title="Add connection">${ICON_PLUS}</button>
        </div>
        <div id="hugr-conn-list" class="hugr-cm-list"></div>
        <div id="hugr-conn-empty" class="hugr-cm-empty">No connections</div>
        <div id="hugr-test-result" class="hugr-cm-result"></div>
      </div>
    `;

    this.node.querySelector('#hugr-btn-add')?.addEventListener('click', () => this._openAddDialog());
    this._loadConnections();
  }

  private async _loadConnections(): Promise<void> {
    try {
      const resp = await hugrFetch(`${BASE_URL}/connections`);
      this._connections = await resp.json();
      this._renderList();
      this._startAuthMonitor();
      if (this._initialLoadDone) {
        document.dispatchEvent(new CustomEvent('hugr:connections-changed', {
          detail: { connections: this._connections },
        }));
      }
      this._initialLoadDone = true;
    } catch (e) {
      console.error('Failed to load connections', e);
    }
  }

  /**
   * Periodically check auth status for browser connections.
   * Shows a notification when a previously authenticated connection expires.
   */
  private _startAuthMonitor(): void {
    // Clear existing timer
    if (this._authMonitorTimer) {
      clearInterval(this._authMonitorTimer);
      this._authMonitorTimer = null;
    }

    const browserConns = this._connections.filter(c => c.auth_type === 'browser');
    if (browserConns.length === 0) return;

    // Update initial state
    for (const c of browserConns) {
      this._previousAuthState.set(c.name, !!c.authenticated);
    }

    // Poll every 30 seconds
    this._authMonitorTimer = setInterval(async () => {
      for (const c of this._connections.filter(conn => conn.auth_type === 'browser')) {
        try {
          const resp = await hugrFetch(`${BASE_URL}/connections/${c.name}/auth`);
          const data = await resp.json();
          const wasAuthenticated = this._previousAuthState.get(c.name) ?? false;
          if (wasAuthenticated && !data.authenticated) {
            this._showResult(
              `<span class="hugr-cm-err">Session expired for "${escapeHtml(c.name)}" — please re-login</span>`
            );
            await this._loadConnections();
            return; // _loadConnections will restart the monitor
          }
          this._previousAuthState.set(c.name, data.authenticated);
        } catch { /* ignore poll errors */ }
      }
    }, 30000);
  }

  dispose(): void {
    if (this._authMonitorTimer) {
      clearInterval(this._authMonitorTimer);
      this._authMonitorTimer = null;
    }
    super.dispose();
  }

  private _renderList(): void {
    const list = this.node.querySelector('#hugr-conn-list') as HTMLElement;
    const empty = this.node.querySelector('#hugr-conn-empty') as HTMLElement;
    if (!list) return;

    if (this._connections.length === 0) {
      list.innerHTML = '';
      empty.style.display = '';
      return;
    }

    empty.style.display = 'none';
    list.innerHTML = this._connections.map(c => {
      const isDefault = c.status === 'default';
      const isBrowser = c.auth_type === 'browser';
      const authDot = isBrowser
        ? (c.authenticated
          ? '<span class="hugr-cm-dot hugr-cm-dot-green" title="Authenticated"></span>'
          : '<span class="hugr-cm-dot hugr-cm-dot-red" title="Not authenticated"></span>')
        : '';
      const authLabel = isBrowser
        ? (c.authenticated ? '<span class="hugr-cm-badge-auth">authenticated</span>' : '<span class="hugr-cm-badge-noauth">not authenticated</span>')
        : '';
      return `
      <div class="hugr-cm-card${isDefault ? ' hugr-cm-card-default' : ''}" data-name="${escapeHtml(c.name)}">
        <div class="hugr-cm-card-main">
          <div class="hugr-cm-card-name">${authDot}${c.read_only ? '<span class="hugr-cm-lock" title="Read-only">&#128274;</span>' : ''}${escapeHtml(c.name)}${isDefault ? ' <span class="hugr-cm-badge-default">default</span>' : ''}</div>
          <div class="hugr-cm-card-actions">
            ${isBrowser ? (c.authenticated
              ? `<button class="hugr-cm-icon-btn hugr-btn-logout-row" data-name="${escapeHtml(c.name)}" title="Logout">${ICON_LOGOUT}</button>`
              : `<button class="hugr-cm-icon-btn hugr-btn-login-row" data-name="${escapeHtml(c.name)}" title="Login">${ICON_LOGIN}</button>`
            ) : ''}
            ${isDefault ? '' : `<button class="hugr-cm-icon-btn hugr-btn-default-row" data-name="${escapeHtml(c.name)}" title="Set as default">${ICON_STAR}</button>`}
            <button class="hugr-cm-icon-btn hugr-btn-test-row" data-name="${escapeHtml(c.name)}" title="Test">${ICON_PLAY}</button>
            ${c.read_only ? '' : `<button class="hugr-cm-icon-btn hugr-btn-del-row" data-name="${escapeHtml(c.name)}" title="Delete">${ICON_TRASH}</button>`}
          </div>
        </div>
        <div class="hugr-cm-card-detail">${escapeHtml(c.url.replace(/^https?:\/\//, ''))} &middot; ${escapeHtml(c.auth_type)}${authLabel ? ' ' + authLabel : ''}</div>
      </div>
    `;
    }).join('');

    list.querySelectorAll('.hugr-btn-default-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const name = (e.currentTarget as HTMLElement).dataset.name;
        if (name) this._setDefault(name);
      });
    });

    list.querySelectorAll('.hugr-btn-del-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const name = (e.currentTarget as HTMLElement).dataset.name;
        if (name) this._deleteConnection(name);
      });
    });

    list.querySelectorAll('.hugr-btn-test-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const name = (e.currentTarget as HTMLElement).dataset.name;
        if (name) this._testConnectionByName(name);
      });
    });

    list.querySelectorAll('.hugr-btn-login-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const name = (e.currentTarget as HTMLElement).dataset.name;
        if (name) this._loginConnection(name);
      });
    });

    list.querySelectorAll('.hugr-btn-logout-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const name = (e.currentTarget as HTMLElement).dataset.name;
        if (name) this._logoutConnection(name);
      });
    });
  }

  private _showResult(html: string): void {
    const el = this.node.querySelector('#hugr-test-result');
    if (el) el.innerHTML = html;
  }

  // ── Full-page modal dialog (not JupyterLab showDialog — stays open on Test) ──

  private _openAddDialog(): void {
    // Create overlay attached to document.body so it's full-page
    const overlay = document.createElement('div');
    overlay.className = 'hugr-dlg-overlay';
    overlay.innerHTML = `
      <div class="hugr-dlg">
        <div class="hugr-dlg-header">
          <span>New Connection</span>
          <button class="hugr-dlg-close">&times;</button>
        </div>
        <div class="hugr-dlg-body">
          <div class="hugr-cm-field">
            <label>Name</label>
            <input type="text" data-field="name" placeholder="my-connection" />
          </div>
          <div class="hugr-cm-field">
            <label>URL</label>
            <input type="text" data-field="url" placeholder="http://localhost:15004/ipc" />
          </div>
          <div class="hugr-cm-field">
            <label>Auth</label>
            <select data-field="auth">
              <option value="public">Public</option>
              <option value="api_key">API Key</option>
              <option value="bearer">Bearer</option>
              <option value="browser">Browser (OIDC)</option>
            </select>
          </div>
          <div class="hugr-cm-field hugr-dlg-role" style="display:none">
            <label>Role</label>
            <input type="text" data-field="role" placeholder="optional" />
          </div>
          <div class="hugr-cm-field hugr-dlg-cred" style="display:none">
            <label class="hugr-dlg-cred-label">Credential</label>
            <input type="password" data-field="credential" placeholder="" />
          </div>
          <div class="hugr-cm-field hugr-dlg-header-name" style="display:none">
            <label>Header Name</label>
            <input type="text" data-field="api_key_header" placeholder="X-Api-Key" />
          </div>
          <div style="margin-top:8px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:var(--jp-ui-font-size1);color:var(--jp-ui-font-color1);">
              <input type="checkbox" data-field="tls_skip_verify" style="width:auto;margin:0;" />
              Skip TLS verification (self-signed certs)
            </label>
          </div>
          <div class="hugr-dlg-result"></div>
        </div>
        <div class="hugr-dlg-footer">
          <button class="hugr-dlg-btn hugr-dlg-btn-cancel">Cancel</button>
          <button class="hugr-dlg-btn hugr-dlg-btn-test">Test</button>
          <button class="hugr-dlg-btn hugr-dlg-btn-save">Save</button>
        </div>
      </div>
    `;

    const close = () => overlay.remove();

    // Close on overlay background click or close button
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('.hugr-dlg-close')?.addEventListener('click', close);
    overlay.querySelector('.hugr-dlg-btn-cancel')?.addEventListener('click', close);

    // Auth type toggle
    const authSelect = overlay.querySelector('[data-field="auth"]') as HTMLSelectElement;
    const credWrap = overlay.querySelector('.hugr-dlg-cred') as HTMLElement;
    const roleWrap = overlay.querySelector('.hugr-dlg-role') as HTMLElement;
    const credLabel = overlay.querySelector('.hugr-dlg-cred-label') as HTMLElement;
    const credInput = overlay.querySelector('[data-field="credential"]') as HTMLInputElement;
    const headerNameWrap = overlay.querySelector('.hugr-dlg-header-name') as HTMLElement;
    authSelect?.addEventListener('change', () => {
      const needsCred = authSelect.value === 'api_key' || authSelect.value === 'bearer';
      credWrap.style.display = needsCred ? '' : 'none';
      roleWrap.style.display = authSelect.value === 'public' || authSelect.value === 'browser' ? 'none' : '';
      headerNameWrap.style.display = authSelect.value === 'api_key' ? '' : 'none';
      credLabel.textContent = authSelect.value === 'api_key' ? 'API Key' : 'Token';
      credInput.placeholder = authSelect.value === 'api_key' ? 'sk-...' : 'Bearer token';
    });

    // Auto-discover OIDC when URL field loses focus
    const urlInput = overlay.querySelector('[data-field="url"]') as HTMLInputElement;
    urlInput?.addEventListener('blur', async () => {
      const url = urlInput.value.trim();
      if (!url || authSelect.value !== 'public') return;
      try {
        const resp = await hugrFetch(`${BASE_URL}/discover`, makeRequest('POST', { url }));
        if (resp.ok) {
          const data = await resp.json();
          if (data.oidc_available) {
            authSelect.value = 'browser';
            authSelect.dispatchEvent(new Event('change'));
            const resultEl = overlay.querySelector('.hugr-dlg-result') as HTMLElement;
            if (resultEl) {
              resultEl.innerHTML = '<span class="hugr-cm-info">OIDC detected — auth set to Browser</span>';
              setTimeout(() => { resultEl.innerHTML = ''; }, 3000);
            }
          }
        }
      } catch { /* ignore discovery errors */ }
    });

    const resultEl = overlay.querySelector('.hugr-dlg-result') as HTMLElement;
    const showMsg = (html: string) => { if (resultEl) resultEl.innerHTML = html; };

    const getVals = () => ({
      name: (overlay.querySelector('[data-field="name"]') as HTMLInputElement)?.value || '',
      url: (overlay.querySelector('[data-field="url"]') as HTMLInputElement)?.value || '',
      auth_type: authSelect?.value || 'public',
      credential: credInput?.value || '',
      role: (overlay.querySelector('[data-field="role"]') as HTMLInputElement)?.value || '',
      api_key_header: (overlay.querySelector('[data-field="api_key_header"]') as HTMLInputElement)?.value || '',
      tls_skip_verify: (overlay.querySelector('[data-field="tls_skip_verify"]') as HTMLInputElement)?.checked || false,
    });

    /** Save connection to server (create or update). */
    const saveConnection = async (vals: ReturnType<typeof getVals>): Promise<boolean> => {
      const body: any = { name: vals.name, url: vals.url, auth_type: vals.auth_type };
      if (vals.auth_type === 'api_key') {
        body.api_key = vals.credential;
        if (vals.api_key_header) body.api_key_header = vals.api_key_header;
      }
      if (vals.auth_type === 'bearer') body.token = vals.credential;
      if (vals.role) body.role = vals.role;
      if (vals.tls_skip_verify) body.tls_skip_verify = true;
      let resp = await hugrFetch(`${BASE_URL}/connections`, makeRequest('POST', body));
      if (resp.status === 409) {
        resp = await hugrFetch(`${BASE_URL}/connections/${vals.name}`, makeRequest('PUT', body));
      }
      return resp.ok;
    };

    /** Start browser login flow: POST login, open auth URL, poll until authenticated. */
    const doBrowserLogin = (name: string): Promise<boolean> => {
      return new Promise(async (resolve) => {
        try {
          const resp = await hugrFetch(`${BASE_URL}/connections/${name}/login`, makeRequest('POST'));
          const data = await resp.json();
          if (!resp.ok) {
            showMsg(`<span class="hugr-cm-err">${escapeHtml(data.error || 'Login failed')}</span>`);
            resolve(false);
            return;
          }
          window.open(data.auth_url, '_blank');
          showMsg('<span class="hugr-cm-info">Waiting for login...</span>');
          // Poll auth status
          let attempts = 0;
          const poll = () => {
            if (attempts > 60) { resolve(false); return; }
            attempts++;
            setTimeout(async () => {
              try {
                const r = await hugrFetch(`${BASE_URL}/connections/${name}/auth`);
                const d = await r.json();
                if (d.authenticated) { resolve(true); return; }
              } catch { /* ignore */ }
              poll();
            }, 2000);
          };
          poll();
        } catch {
          showMsg('<span class="hugr-cm-err">Login failed</span>');
          resolve(false);
        }
      });
    };

    // Test button — does NOT close, does NOT save for non-browser
    overlay.querySelector('.hugr-dlg-btn-test')?.addEventListener('click', async () => {
      const vals = getVals();
      if (!vals.url) { showMsg('<span class="hugr-cm-err">URL is required</span>'); return; }
      showMsg('<span class="hugr-cm-info">Testing...</span>');

      if (vals.auth_type === 'browser') {
        // Browser: server-side test — POST /hugr/test starts OIDC login, callback runs test query
        try {
          const resp = await hugrFetch(`${BASE_URL}/test`, makeRequest('POST', { url: vals.url, auth_type: 'browser', tls_skip_verify: vals.tls_skip_verify }));
          const data = await resp.json();
          if (!resp.ok) {
            showMsg(`<span class="hugr-cm-err">${escapeHtml(data.error || 'Test failed')}</span>`);
            return;
          }
          // Open auth URL in new tab
          window.open(data.auth_url, '_blank');
          showMsg('<span class="hugr-cm-info">Waiting for login & test...</span>');
          // Poll GET /hugr/test/<test_id> for result
          const testId = data.test_id;
          let attempts = 0;
          const poll = () => {
            if (attempts > 60) {
              showMsg('<span class="hugr-cm-err">Test timed out</span>');
              return;
            }
            attempts++;
            setTimeout(async () => {
              try {
                const r = await hugrFetch(`${BASE_URL}/test/${encodeURIComponent(testId)}`);
                const result = await r.json();
                if (result.status === 'pending' || (result.ok === undefined && !result.error)) {
                  poll();
                  return;
                }
                if (result.ok) {
                  showMsg(`<span class="hugr-cm-ok">v${escapeHtml(String(result.version || 'unknown'))}</span>`);
                } else {
                  showMsg(`<span class="hugr-cm-err">${escapeHtml(result.error || 'Test failed')}</span>`);
                }
              } catch {
                poll();
              }
            }, 2000);
          };
          poll();
        } catch {
          showMsg('<span class="hugr-cm-err">Test failed</span>');
        }
        return;
      }

      // Always test via server endpoint — handles TLS and auth server-side
      try {
        const resp = await hugrFetch(`${BASE_URL}/test`, makeRequest('POST', {
          url: vals.url,
          auth_type: vals.auth_type,
          api_key: vals.auth_type === 'api_key' ? vals.credential : undefined,
          api_key_header: vals.auth_type === 'api_key' && vals.api_key_header ? vals.api_key_header : undefined,
          token: vals.auth_type === 'bearer' ? vals.credential : undefined,
          role: vals.role || undefined,
          tls_skip_verify: vals.tls_skip_verify,
        }));
        const data = await resp.json();
        if (data.ok) {
          showMsg(`<span class="hugr-cm-ok">v${escapeHtml(String(data.version || 'unknown'))}</span>`);
        } else {
          showMsg(`<span class="hugr-cm-err">${escapeHtml(data.error || 'Test failed')}</span>`);
        }
      } catch {
        showMsg('<span class="hugr-cm-err">Connection failed</span>');
      }
    });

    // Save button — closes immediately, login starts in background
    overlay.querySelector('.hugr-dlg-btn-save')?.addEventListener('click', async () => {
      const vals = getVals();
      if (!vals.name || !vals.url) { showMsg('<span class="hugr-cm-err">Name and URL are required</span>'); return; }

      try {
        const saved = await saveConnection(vals);
        if (!saved) { showMsg('<span class="hugr-cm-err">Save failed</span>'); return; }

        // Always update list and close dialog first
        await this._loadConnections();
        close();

        // For browser connections: start login in background (don't block)
        if (vals.auth_type === 'browser') {
          this._showResult('<span class="hugr-cm-info">Saved. Starting login...</span>');
          doBrowserLogin(vals.name).then(loggedIn => {
            if (loggedIn) {
              this._showResult('<span class="hugr-cm-ok">Logged in</span>');
            } else {
              this._showResult('<span class="hugr-cm-err">Login failed — click login to retry</span>');
            }
            void this._loadConnections();
            setTimeout(() => this._showResult(''), 4000);
          });
        } else {
          this._showResult('<span class="hugr-cm-ok">Saved. Restart running kernels to apply.</span>');
          setTimeout(() => this._showResult(''), 4000);
        }
      } catch {
        showMsg('<span class="hugr-cm-err">Save failed</span>');
      }
    });

    document.body.appendChild(overlay);
    // Focus name input
    (overlay.querySelector('[data-field="name"]') as HTMLInputElement)?.focus();
  }

  private async _testConnectionByName(name: string): Promise<void> {
    // Single modal — show "Testing..." then update with result via server-side test
    const overlay = document.createElement('div');
    overlay.className = 'hugr-dlg-overlay';
    overlay.innerHTML = `
      <div class="hugr-dlg hugr-dlg-sm">
        <div class="hugr-dlg-header">
          <span>Test: ${escapeHtml(name)}</span>
          <button class="hugr-dlg-close">&times;</button>
        </div>
        <div class="hugr-dlg-body"><span class="hugr-cm-info">Testing...</span></div>
        <div class="hugr-dlg-footer">
          <button class="hugr-dlg-btn hugr-dlg-btn-save">OK</button>
        </div>
      </div>
    `;
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.hugr-dlg-close')?.addEventListener('click', close);
    overlay.querySelector('.hugr-dlg-btn-save')?.addEventListener('click', close);
    document.body.appendChild(overlay);

    const bodyEl = overlay.querySelector('.hugr-dlg-body') as HTMLElement;
    try {
      const resp = await hugrFetch(`${BASE_URL}/connections/${name}/test`, makeRequest('POST'));
      const result = await resp.json();
      if (result.ok) {
        bodyEl.innerHTML = `<span class="hugr-cm-ok">v${escapeHtml(String(result.version || 'unknown'))}</span>`;
      } else {
        bodyEl.innerHTML = `<span class="hugr-cm-err">${escapeHtml(result.error || 'Test failed')}</span>`;
      }
    } catch {
      bodyEl.innerHTML = '<span class="hugr-cm-err">Connection failed</span>';
    }
  }

  private async _setDefault(name: string): Promise<void> {
    try {
      await hugrFetch(`${BASE_URL}/connections/${name}/default`, makeRequest('PUT'));
      await this._loadConnections();
    } catch (e) {
      console.error('Failed to set default connection', e);
    }
  }

  private async _deleteConnection(name: string): Promise<void> {
    const confirmed = await this._showConfirm(`Delete "${escapeHtml(name)}"?`, 'This connection will be removed. Running kernels will keep using it until restarted.');
    if (!confirmed) return;
    try {
      await hugrFetch(`${BASE_URL}/connections/${name}`, makeRequest('DELETE'));
      await this._loadConnections();
    } catch (e) {
      console.error('Failed to delete connection', e);
    }
  }


  private async _loginConnection(name: string): Promise<void> {
    this._showResult('<span class="hugr-cm-info">Starting login...</span>');
    try {
      const resp = await hugrFetch(`${BASE_URL}/connections/${name}/login`, makeRequest('POST'));
      const data = await resp.json();
      if (!resp.ok) {
        this._showResult(`<span class="hugr-cm-err">${escapeHtml(data.error || 'Login failed')}</span>`);
        setTimeout(() => this._showResult(''), 5000);
        return;
      }
      // Open auth URL in new window
      window.open(data.auth_url, '_blank');
      this._showResult('<span class="hugr-cm-info">Waiting for login...</span>');
      // Poll for auth status
      this._pollAuthStatus(name);
    } catch (e) {
      this._showResult('<span class="hugr-cm-err">Login failed</span>');
      setTimeout(() => this._showResult(''), 5000);
    }
  }

  private _pollAuthStatus(name: string, attempts = 0): void {
    if (attempts > 60) { // 2 minutes max
      this._showResult('<span class="hugr-cm-err">Login timed out</span>');
      setTimeout(() => this._showResult(''), 5000);
      return;
    }
    setTimeout(async () => {
      try {
        const resp = await hugrFetch(`${BASE_URL}/connections/${name}/auth`);
        const data = await resp.json();
        if (data.authenticated) {
          this._showResult('<span class="hugr-cm-ok">Logged in</span>');
          setTimeout(() => this._showResult(''), 3000);
          await this._loadConnections();
          return;
        }
      } catch { /* ignore poll errors */ }
      this._pollAuthStatus(name, attempts + 1);
    }, 2000);
  }

  private async _logoutConnection(name: string): Promise<void> {
    try {
      const resp = await hugrFetch(`${BASE_URL}/connections/${name}/logout`, makeRequest('POST'));
      const data = await resp.json();
      if (data.end_session_url) {
        // Open IdP logout in new tab — redirects back to /hugr/oauth/logout which auto-closes
        window.open(data.end_session_url, '_blank');
      }
      await this._loadConnections();
      this._showResult('<span class="hugr-cm-ok">Logged out</span>');
      setTimeout(() => this._showResult(''), 3000);
    } catch (e) {
      console.error('Logout failed', e);
    }
  }

  /** Show a confirm dialog. Returns true if user clicks Delete, false on Cancel. */
  private _showConfirm(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'hugr-dlg-overlay';
      overlay.innerHTML = `
        <div class="hugr-dlg hugr-dlg-sm">
          <div class="hugr-dlg-header">
            <span>${title}</span>
            <button class="hugr-dlg-close">&times;</button>
          </div>
          <div class="hugr-dlg-body"><p>${escapeHtml(message)}</p></div>
          <div class="hugr-dlg-footer">
            <button class="hugr-dlg-btn hugr-dlg-btn-cancel">Cancel</button>
            <button class="hugr-dlg-btn hugr-dlg-btn-danger">Delete</button>
          </div>
        </div>
      `;
      const close = (result: boolean) => {
        document.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        resolve(result);
      };
      const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
      document.addEventListener('keydown', onKeyDown);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
      overlay.querySelector('.hugr-dlg-close')?.addEventListener('click', () => close(false));
      overlay.querySelector('.hugr-dlg-btn-cancel')?.addEventListener('click', () => close(false));
      overlay.querySelector('.hugr-dlg-btn-danger')?.addEventListener('click', () => close(true));
      document.body.appendChild(overlay);
    });
  }
}
