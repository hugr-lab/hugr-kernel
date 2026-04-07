/**
 * HugrExplorerWidget — unified explorer panel with connection selector,
 * tabbed sections (Schema, Types, Directives), and pluggable section containers.
 */

import { Widget } from '@lumino/widgets';
import { LabIcon } from '@jupyterlab/ui-components';
import { PageConfig } from '@jupyterlab/coreutils';
import { HugrClient } from '../hugrClient';

const explorerIcon = new LabIcon({
  name: '@hugr-lab/jupyterlab-graphql-ide:explorer-icon',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="4" r="2.5" fill="currentColor" opacity="0.3" stroke="currentColor"/>' +
    '<circle cx="5" cy="12" r="2.5" fill="currentColor" opacity="0.3" stroke="currentColor"/>' +
    '<circle cx="19" cy="12" r="2.5" fill="currentColor" opacity="0.3" stroke="currentColor"/>' +
    '<circle cx="3" cy="20" r="2" fill="currentColor" opacity="0.3" stroke="currentColor"/>' +
    '<circle cx="9" cy="20" r="2" fill="currentColor" opacity="0.3" stroke="currentColor"/>' +
    '<circle cx="16" cy="20" r="2" fill="currentColor" opacity="0.3" stroke="currentColor"/>' +
    '<circle cx="22" cy="20" r="2" fill="currentColor" opacity="0.3" stroke="currentColor"/>' +
    '<line x1="12" y1="6.5" x2="5" y2="9.5"/>' +
    '<line x1="12" y1="6.5" x2="19" y2="9.5"/>' +
    '<line x1="5" y1="14.5" x2="3" y2="18"/>' +
    '<line x1="5" y1="14.5" x2="9" y2="18"/>' +
    '<line x1="19" y1="14.5" x2="16" y2="18"/>' +
    '<line x1="19" y1="14.5" x2="22" y2="18"/>' +
    '</svg>',
});

type SectionName = 'schema' | 'types' | 'directives';

export class HugrExplorerWidget extends Widget {
  private _client: HugrClient | null = null;
  private _connections: any[] = [];
  private _selectedConnection: string | null = null;
  private _schemaSection: HTMLElement | null = null;
  private _typesSection: HTMLElement | null = null;
  private _directivesSection: HTMLElement | null = null;
  private _activeSection: SectionName = 'schema';

  constructor() {
    super();
    this.id = 'hugr-explorer';
    this.addClass('hugr-explorer');
    this.title.icon = explorerIcon;
    this.title.caption = 'Hugr Explorer';
    this.title.closable = true;
    this._render();
  }

  get client(): HugrClient | null {
    return this._client;
  }

  get selectedConnection(): string | null {
    return this._selectedConnection;
  }

  getClient(): HugrClient | null {
    return this._client;
  }

  setConnections(connections: any[], defaultName: string | null): void {
    const prevSelected = this._selectedConnection;
    this._connections = connections;
    if (defaultName !== null) {
      this._selectedConnection = defaultName;
    }
    this._render();
    // Only reload if connection changed or client not yet created
    if (this._selectedConnection && (this._selectedConnection !== prevSelected || !this._client)) {
      this._onConnectionChange(this._selectedConnection);
    }
  }

  /**
   * Update only the connections dropdown without re-rendering sections.
   * Used when connections change (add/delete/login) to avoid aborting active queries.
   */
  updateConnectionsList(connections: any[]): void {
    this._connections = connections;
    const select = this.node.querySelector('.hugr-explorer-conn-select') as HTMLSelectElement | null;
    if (!select) return;

    const current = select.value;
    select.innerHTML = '';
    for (const conn of connections) {
      const name = typeof conn === 'string' ? conn : conn.name ?? String(conn);
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      if (name === current) option.selected = true;
      select.appendChild(option);
    }
  }

  /**
   * Switch to the Types tab and trigger a search query.
   * Enables cross-reference navigation from schema tree and detail modals.
   */
  navigateToTypes(searchQuery: string): void {
    this._onTabClick('types');

    this.node.dispatchEvent(
      new CustomEvent('hugr-types-search', {
        bubbles: true,
        detail: { query: searchQuery }
      })
    );
  }

  /**
   * Switch to the Directives tab and highlight a specific directive.
   * Enables cross-reference navigation from hover tooltips.
   */
  navigateToDirectives(directiveName: string): void {
    this._onTabClick('directives');

    this.node.dispatchEvent(
      new CustomEvent('hugr-directive-search', {
        bubbles: true,
        detail: { query: directiveName }
      })
    );
  }

  getSectionContainer(section: SectionName): HTMLElement | null {
    switch (section) {
      case 'schema':
        return this._schemaSection;
      case 'types':
        return this._typesSection;
      case 'directives':
        return this._directivesSection;
      default:
        return null;
    }
  }

  private _render(): void {
    const node = this.node;
    node.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'hugr-explorer-container';

    if (this._connections.length === 0) {
      container.innerHTML =
        '<div class="hugr-explorer-empty">Add a connection in Connection Manager</div>';
      node.appendChild(container);
      this._schemaSection = null;
      this._typesSection = null;
      this._directivesSection = null;
      return;
    }

    // Connection selector bar
    const connBar = document.createElement('div');
    connBar.className = 'hugr-explorer-conn-bar';

    const select = document.createElement('select');
    select.className = 'hugr-explorer-conn-select';
    for (const conn of this._connections) {
      const option = document.createElement('option');
      const name =
        typeof conn === 'string' ? conn : conn.name ?? String(conn);
      option.value = name;
      option.textContent = name;
      if (name === this._selectedConnection) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      this._onConnectionChange(select.value);
    });
    connBar.appendChild(select);

    // Refresh button — reloads all sections for the current connection
    const refreshBtn = document.createElement('span');
    refreshBtn.className = 'hugr-explorer-conn-refresh';
    refreshBtn.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;' +
      'width:22px;height:22px;flex-shrink:0;cursor:pointer;' +
      'border-radius:3px;font-size:14px;opacity:0.6;margin-left:4px;' +
      'color:var(--jp-ui-font-color1, #333);';
    refreshBtn.textContent = '\u21BB';
    refreshBtn.title = 'Refresh all sections';
    refreshBtn.addEventListener('mouseenter', () => {
      refreshBtn.style.opacity = '1';
      refreshBtn.style.backgroundColor = 'var(--jp-layout-color3, #ddd)';
    });
    refreshBtn.addEventListener('mouseleave', () => {
      refreshBtn.style.opacity = '0.6';
      refreshBtn.style.backgroundColor = '';
    });
    refreshBtn.addEventListener('click', () => {
      if (this._selectedConnection) {
        this._onConnectionChange(this._selectedConnection);
      }
    });
    connBar.appendChild(refreshBtn);

    container.appendChild(connBar);

    // Tab buttons
    const tabs = document.createElement('div');
    tabs.className = 'hugr-explorer-tabs';

    const sections: { key: SectionName; label: string }[] = [
      { key: 'schema', label: 'Schema' },
      { key: 'types', label: 'Types' },
      { key: 'directives', label: 'Directives' }
    ];

    for (const sec of sections) {
      const btn = document.createElement('button');
      btn.className = 'hugr-explorer-tab';
      if (sec.key === this._activeSection) {
        btn.classList.add('active');
      }
      btn.dataset.section = sec.key;
      btn.textContent = sec.label;
      btn.addEventListener('click', () => {
        this._onTabClick(sec.key);
      });
      tabs.appendChild(btn);
    }
    container.appendChild(tabs);

    // Content area with section containers
    const content = document.createElement('div');
    content.className = 'hugr-explorer-content';

    const schemaDiv = document.createElement('div');
    schemaDiv.className = 'hugr-explorer-section';
    schemaDiv.dataset.section = 'schema';
    schemaDiv.style.display = this._activeSection === 'schema' ? '' : 'none';
    this._schemaSection = schemaDiv;
    content.appendChild(schemaDiv);

    const typesDiv = document.createElement('div');
    typesDiv.className = 'hugr-explorer-section';
    typesDiv.dataset.section = 'types';
    typesDiv.style.display = this._activeSection === 'types' ? '' : 'none';
    this._typesSection = typesDiv;
    content.appendChild(typesDiv);

    const directivesDiv = document.createElement('div');
    directivesDiv.className = 'hugr-explorer-section';
    directivesDiv.dataset.section = 'directives';
    directivesDiv.style.display =
      this._activeSection === 'directives' ? '' : 'none';
    this._directivesSection = directivesDiv;
    content.appendChild(directivesDiv);

    container.appendChild(content);
    node.appendChild(container);
  }

  private _onConnectionChange(name: string): void {
    // Abort previous client if it exists
    if (this._client) {
      this._client.abort();
    }

    // Always use proxy — handles auth and TLS (self-signed certs) server-side
    const proxyUrl = `${PageConfig.getBaseUrl()}hugr/proxy/${encodeURIComponent(name)}`;

    this._client = new HugrClient({
      url: proxyUrl,
      authType: 'public', // proxy adds auth headers server-side
      connectionName: name,
    });

    this._selectedConnection = name;

    // Update the dropdown to reflect the new selection
    const select = this.node.querySelector(
      '.hugr-explorer-conn-select'
    ) as HTMLSelectElement | null;
    if (select) {
      select.value = name;
    }

    this.node.dispatchEvent(
      new CustomEvent('hugr-connection-changed', {
        bubbles: true,
        detail: { name, client: this._client }
      })
    );
  }

  private _onTabClick(section: SectionName): void {
    this._activeSection = section;

    // Update tab active classes
    const tabButtons = this.node.querySelectorAll('.hugr-explorer-tab');
    tabButtons.forEach(btn => {
      const el = btn as HTMLElement;
      if (el.dataset.section === section) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });

    // Show/hide section divs
    const sectionDivs = this.node.querySelectorAll('.hugr-explorer-section');
    sectionDivs.forEach(div => {
      const el = div as HTMLElement;
      el.style.display = el.dataset.section === section ? '' : 'none';
    });

    this.node.dispatchEvent(
      new CustomEvent('hugr-section-changed', {
        bubbles: true,
        detail: { section }
      })
    );
  }
}
