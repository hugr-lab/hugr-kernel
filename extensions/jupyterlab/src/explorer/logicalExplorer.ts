/**
 * JupyterLab widget for the Hugr logical explorer.
 *
 * Shows a tree of data sources, modules, submodules, tables, views,
 * and functions from the Hugr server. Supports:
 * - Connection header with active connection name + version
 * - Connection switcher dropdown
 * - Lazy child loading via CommClient
 * - Debounced search (300ms)
 * - Node click opens detail modal
 */

import { Widget } from '@lumino/widgets';
import {
  CommClient,
  ExplorerNode,
} from '../commClient.js';
import { SearchBar } from './searchBar.js';
import { showDetailModal } from './detailModal.js';

/* ========== kind icons ========== */

const KIND_ICONS: Record<string, string> = {
  DataSource: '\uD83D\uDDC4', // file cabinet
  Module: '\uD83D\uDCE6',     // package
  Table: '\u229E',             // squared plus
  View: '\uD83D\uDC41',       // eye
  Function: '\u0192',          // latin small f with hook
  Type: '\u25C7',              // diamond
  Field: '\u25CB',             // circle
  EnumValue: '\u25AA',         // small square
};

function iconForKind(kind: string): string {
  return KIND_ICONS[kind] ?? '\u25CF'; // filled circle fallback
}

/* ========== helpers ========== */

function esc(text: unknown): string {
  const el = document.createElement('span');
  el.textContent = String(text ?? '');
  return el.innerHTML;
}

/* ========== tree node factory ========== */

/**
 * Create a DOM element for an explorer node. If the node has children,
 * clicking it will lazy-load them via the client.
 */
function createTreeNode(
  node: ExplorerNode,
  client: CommClient,
  searchQuery: string,
): HTMLElement {
  const item = document.createElement('div');
  item.className = 'hugr-tree-item';
  item.dataset.nodeId = node.id;

  const row = document.createElement('div');
  row.className = 'hugr-tree-row';

  // Toggle arrow (only if node has children)
  const toggle = document.createElement('span');
  toggle.className = 'hugr-tree-toggle';
  toggle.textContent = node.hasChildren ? '\u25B6' : ' ';
  row.appendChild(toggle);

  // Kind icon
  const icon = document.createElement('span');
  icon.className = 'hugr-obj-icon';
  icon.textContent = iconForKind(node.kind);
  row.appendChild(icon);

  // Label
  const label = document.createElement('span');
  label.className = 'hugr-tree-label';
  label.textContent = node.label;
  row.appendChild(label);

  // Description (dimmed)
  if (node.description) {
    const desc = document.createElement('span');
    desc.className = 'hugr-tree-desc';
    desc.textContent = node.description;
    row.appendChild(desc);
  }

  // Info button
  const infoBtn = document.createElement('button');
  infoBtn.className = 'hugr-info-btn';
  infoBtn.textContent = '\u2139'; // info symbol
  infoBtn.title = `Details: ${node.label}`;
  infoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void showDetailModal(client, node.id);
  });
  row.appendChild(infoBtn);

  item.appendChild(row);

  // Children container (hidden until expanded)
  const childrenEl = document.createElement('div');
  childrenEl.className = 'hugr-tree-children';
  childrenEl.style.display = 'none';
  item.appendChild(childrenEl);

  let loaded = false;

  const doExpand = () => {
    childrenEl.style.display = 'block';
    toggle.textContent = '\u25BC';
    if (!loaded) {
      loaded = true;
      childrenEl.innerHTML = '<div class="hugr-loading">Loading...</div>';
      client
        .logicalChildren(node.id, searchQuery || undefined)
        .then((children) => {
          childrenEl.innerHTML = '';
          if (children.length === 0) {
            childrenEl.innerHTML = '<div class="hugr-empty">(empty)</div>';
          } else {
            for (const child of children) {
              childrenEl.appendChild(
                createTreeNode(child, client, searchQuery),
              );
            }
          }
        })
        .catch((err: any) => {
          childrenEl.innerHTML = `<div class="hugr-error">${esc(err.message)}</div>`;
        });
    }
  };

  if (node.hasChildren) {
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const isOpen = childrenEl.style.display !== 'none';
      if (isOpen) {
        childrenEl.style.display = 'none';
        toggle.textContent = '\u25B6';
      } else {
        doExpand();
      }
    });
  }

  return item;
}

/* ========== main widget ========== */

export class HugrLogicalExplorer extends Widget {
  private client: CommClient | null = null;
  private searchBar: SearchBar;
  private treeEl: HTMLElement;
  private currentSearch = '';

  constructor() {
    super();
    this.addClass('hugr-logical-explorer');
    this.id = 'hugr-logical-explorer';
    this.title.label = 'Hugr Explorer';
    this.title.caption = 'Hugr Logical Explorer';
    this.title.closable = true;

    // Header with title + refresh
    const header = document.createElement('div');
    header.className = 'hugr-explorer-header';
    header.innerHTML = '<span class="hugr-explorer-title">Logical Schema</span>';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'hugr-refresh-btn';
    refreshBtn.textContent = '\u21BB';
    refreshBtn.title = 'Refresh explorer';
    refreshBtn.addEventListener('click', () => void this.refresh());
    header.appendChild(refreshBtn);

    this.node.appendChild(header);

    // Search bar
    this.searchBar = new SearchBar({
      placeholder: 'Search data sources...',
      onSearch: (query) => {
        this.currentSearch = query;
        void this.loadTree();
      },
    });
    this.node.appendChild(this.searchBar.node);

    // Tree container
    this.treeEl = document.createElement('div');
    this.treeEl.className = 'hugr-explorer-tree';
    this.node.appendChild(this.treeEl);
  }

  /** Set the explorer client (called when kernel is discovered). */
  setClient(client: CommClient | null): void {
    this.client = client;
    void this.refresh();
  }

  /** Full refresh: reload tree. */
  async refresh(): Promise<void> {
    if (!this.client) {
      this.treeEl.innerHTML =
        '<div class="hugr-explorer-placeholder">No active kernel</div>';
      return;
    }

    await this.loadTree();
  }

  /* ==================== tree ==================== */

  private async loadTree(): Promise<void> {
    if (!this.client) {
      this.treeEl.innerHTML = '';
      return;
    }

    this.treeEl.innerHTML = '<div class="hugr-loading">Loading...</div>';

    try {
      let nodes: ExplorerNode[];

      if (this.currentSearch) {
        // Use search endpoint for filtered results
        nodes = await this.client.search(this.currentSearch, 'logical', 50);
      } else {
        // Load root data sources
        nodes = await this.client.logicalRoots();
      }

      this.treeEl.innerHTML = '';

      if (nodes.length === 0) {
        this.treeEl.innerHTML = this.currentSearch
          ? '<div class="hugr-empty">No results found.</div>'
          : '<div class="hugr-empty">No data sources available.</div>';
        return;
      }

      for (const node of nodes) {
        this.treeEl.appendChild(
          createTreeNode(node, this.client, this.currentSearch),
        );
      }
    } catch (err: any) {
      this.treeEl.innerHTML =
        `<div class="hugr-error">${esc(err.message)}</div>`;
    }
  }
}
