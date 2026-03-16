/**
 * Catalog Explorer sidebar widget.
 */
import { Widget } from '@lumino/widgets';
import { CommClient } from '../commClient';
import { SearchBar } from './searchBar';

interface TreeNode {
  id: string;
  label: string;
  kind: string;
  description?: string;
  hasChildren: boolean;
  children?: TreeNode[];
  expanded?: boolean;
}

export class LogicalExplorerWidget extends Widget {
  private _commClient: CommClient;
  private _nodes: TreeNode[] = [];
  private _serverInfo: any = {};

  constructor(commClient: CommClient) {
    super();
    this.id = 'hugr-logical-explorer';
    this._commClient = commClient;
    this.addClass('hugr-logical-explorer');
    this.title.label = 'Hugr Catalog';
    this.title.closable = true;
  }

  async refresh(): Promise<void> {
    try {
      const resp = await this._commClient.request('logical_roots');
      this._serverInfo = (resp as any).info || {};
      this._nodes = ((resp as any).nodes || []).map((n: any) => ({
        ...n,
        children: [],
        expanded: false,
      }));
      this._render();
    } catch (e) {
      this.node.innerHTML = '<p class="hugr-empty">Connect to a Hugr server to explore</p>';
    }
  }

  private _render(): void {
    const info = this._serverInfo;
    const header = info.version
      ? `<div class="hugr-explorer-header">
          <strong>Hugr</strong> v${info.version} (${info.cluster_mode || ''})
          <button class="hugr-btn-refresh">↻</button>
        </div>`
      : '';

    const tree = this._renderNodes(this._nodes);
    this.node.innerHTML = `${header}<div class="hugr-tree">${tree}</div>`;

    this.node.querySelector('.hugr-btn-refresh')?.addEventListener('click', () => this.refresh());
    this._attachNodeHandlers();
  }

  private _renderNodes(nodes: TreeNode[], indent = 0): string {
    return nodes.map(n => {
      const icon = this._kindIcon(n.kind);
      const expandIcon = n.hasChildren ? (n.expanded ? '▼' : '▶') : ' ';
      const children = n.expanded && n.children?.length
        ? this._renderNodes(n.children, indent + 1)
        : '';
      const desc = n.description ? ` <span class="hugr-node-desc">(${n.description})</span>` : '';
      return `
        <div class="hugr-tree-node" data-id="${n.id}" style="padding-left:${indent * 16}px">
          <span class="hugr-node-expand" data-id="${n.id}">${expandIcon}</span>
          <span class="hugr-node-icon">${icon}</span>
          <span class="hugr-node-label" data-id="${n.id}">${n.label}</span>${desc}
        </div>
        ${children}
      `;
    }).join('');
  }

  private _kindIcon(kind: string): string {
    const icons: Record<string, string> = {
      DataSource: '💾', Module: '📦', Table: '📊',
      View: '👁', Function: '⚡', Type: '📐',
    };
    return icons[kind] || '📄';
  }

  private _attachNodeHandlers(): void {
    this.node.querySelectorAll('.hugr-node-expand').forEach(el => {
      el.addEventListener('click', async (e) => {
        const id = (e.target as HTMLElement).dataset.id;
        if (id) await this._toggleNode(id);
      });
    });

    this.node.querySelectorAll('.hugr-node-label').forEach(el => {
      el.addEventListener('click', async (e) => {
        const id = (e.target as HTMLElement).dataset.id;
        if (id) this._onNodeClick(id);
      });
    });
  }

  private _findNode(id: string, nodes: TreeNode[] = this._nodes): TreeNode | null {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children) {
        const found = this._findNode(id, n.children);
        if (found) return found;
      }
    }
    return null;
  }

  private async _toggleNode(id: string): Promise<void> {
    const node = this._findNode(id);
    if (!node || !node.hasChildren) return;

    if (node.expanded) {
      node.expanded = false;
    } else {
      if (!node.children?.length) {
        const resp = await this._commClient.request('logical_children', { node_id: id });
        node.children = ((resp as any).nodes || []).map((n: any) => ({
          ...n,
          children: [],
          expanded: false,
        }));
      }
      node.expanded = true;
    }
    this._render();
  }

  private _onNodeClick(id: string): void {
    // Detail modal will be opened by plugin.ts
    const event = new CustomEvent('hugr-node-click', { detail: { nodeId: id } });
    this.node.dispatchEvent(event);
  }
}
