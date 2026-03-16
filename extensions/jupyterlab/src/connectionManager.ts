/**
 * Hugr Connection Manager — JupyterLab sidebar widget.
 *
 * Displays current Hugr connections and allows:
 * - Adding new connections (name + URL)
 * - Removing connections
 * - Switching the default connection
 * - Viewing connection status
 *
 * Communicates with the kernel via CommClient (Jupyter comm protocol).
 */

import { Widget } from '@lumino/widgets';
import { CommClient, ConnectionStatus } from './commClient.js';

function esc(text: unknown): string {
  const el = document.createElement('span');
  el.textContent = String(text ?? '');
  return el.innerHTML;
}

export class HugrConnectionManager extends Widget {
  private client: CommClient | null = null;
  private contentEl: HTMLElement;

  constructor() {
    super();
    this.addClass('hugr-connection-manager');
    this.id = 'hugr-connection-manager';
    this.title.label = 'Hugr Connections';
    this.title.caption = 'Hugr Connection Manager';
    this.title.closable = true;

    // Header
    const header = document.createElement('div');
    header.className = 'hugr-explorer-header';
    header.innerHTML = '<span class="hugr-explorer-title">Connections</span>';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'hugr-refresh-btn';
    refreshBtn.textContent = '\u21BB';
    refreshBtn.title = 'Refresh connections';
    refreshBtn.addEventListener('click', () => void this.refresh());
    header.appendChild(refreshBtn);

    this.node.appendChild(header);

    // Add connection form
    const form = this.createAddForm();
    this.node.appendChild(form);

    // Connection list
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'hugr-connection-list';
    this.node.appendChild(this.contentEl);
  }

  setClient(client: CommClient | null): void {
    this.client = client;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.client) {
      this.contentEl.innerHTML =
        '<div class="hugr-explorer-placeholder">No active kernel</div>';
      return;
    }

    this.contentEl.innerHTML = '<div class="hugr-loading">Loading...</div>';

    try {
      const connections = await this.client.connections();
      this.renderConnections(connections);
    } catch (err: any) {
      this.contentEl.innerHTML =
        `<div class="hugr-error">${esc(err.message)}</div>`;
    }
  }

  private createAddForm(): HTMLElement {
    const form = document.createElement('div');
    form.className = 'hugr-add-connection-form';

    const nameInput = document.createElement('input');
    nameInput.className = 'hugr-input';
    nameInput.placeholder = 'Name';
    nameInput.type = 'text';

    const urlInput = document.createElement('input');
    urlInput.className = 'hugr-input';
    urlInput.placeholder = 'URL (e.g. http://localhost:3000)';
    urlInput.type = 'text';

    const addBtn = document.createElement('button');
    addBtn.className = 'hugr-add-btn';
    addBtn.textContent = 'Connect';
    addBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const url = urlInput.value.trim();
      if (!name || !url || !this.client) return;

      addBtn.disabled = true;
      try {
        await this.client.addConnection(name, url);
        nameInput.value = '';
        urlInput.value = '';
        await this.refresh();
      } catch (err: any) {
        console.error('[hugr] add connection error:', err);
      } finally {
        addBtn.disabled = false;
      }
    });

    form.appendChild(nameInput);
    form.appendChild(urlInput);
    form.appendChild(addBtn);
    return form;
  }

  private renderConnections(connections: ConnectionStatus[]): void {
    this.contentEl.innerHTML = '';

    if (connections.length === 0) {
      this.contentEl.innerHTML =
        '<div class="hugr-explorer-placeholder">No connections. Add one above.</div>';
      return;
    }

    for (const conn of connections) {
      this.contentEl.appendChild(this.createConnectionItem(conn));
    }
  }

  private createConnectionItem(conn: ConnectionStatus): HTMLElement {
    const item = document.createElement('div');
    item.className = 'hugr-connection-item' + (conn.active ? ' hugr-connection-active' : '');

    const info = document.createElement('div');
    info.className = 'hugr-connection-item-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'hugr-connection-item-name';
    nameEl.textContent = conn.name;
    if (conn.active) {
      nameEl.textContent += ' (default)';
    }
    info.appendChild(nameEl);

    const urlEl = document.createElement('span');
    urlEl.className = 'hugr-connection-item-url';
    urlEl.textContent = conn.url;
    info.appendChild(urlEl);

    if (conn.version) {
      const versionEl = document.createElement('span');
      versionEl.className = 'hugr-connection-item-version';
      versionEl.textContent = `v${conn.version}`;
      info.appendChild(versionEl);
    }

    item.appendChild(info);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'hugr-connection-actions';

    if (!conn.active) {
      const useBtn = document.createElement('button');
      useBtn.className = 'hugr-action-btn';
      useBtn.textContent = 'Use';
      useBtn.title = 'Set as default connection';
      useBtn.addEventListener('click', async () => {
        if (!this.client) return;
        try {
          await this.client.setDefault(conn.name);
          await this.refresh();
        } catch (err: any) {
          console.error('[hugr] set default error:', err);
        }
      });
      actions.appendChild(useBtn);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'hugr-action-btn hugr-action-btn-danger';
    removeBtn.textContent = '\u2715';
    removeBtn.title = 'Remove connection';
    removeBtn.addEventListener('click', async () => {
      if (!this.client) return;
      try {
        await this.client.removeConnection(conn.name);
        await this.refresh();
      } catch (err: any) {
        console.error('[hugr] remove connection error:', err);
      }
    });
    actions.appendChild(removeBtn);

    item.appendChild(actions);
    return item;
  }
}
