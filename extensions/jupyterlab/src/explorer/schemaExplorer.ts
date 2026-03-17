/**
 * Schema Explorer sidebar widget.
 */
import { Widget } from '@lumino/widgets';
import { CommClient } from '../commClient';
import { escapeHtml } from '../utils';

interface SchemaNode {
  id: string;
  label: string;
  kind: string;
  description?: string;
  hasChildren: boolean;
  metadata?: any;
  children?: SchemaNode[];
  expanded?: boolean;
}

export class SchemaExplorerWidget extends Widget {
  private _commClient: CommClient;
  private _nodes: SchemaNode[] = [];

  constructor(commClient: CommClient) {
    super();
    this.id = 'hugr-schema-explorer';
    this._commClient = commClient;
    this.addClass('hugr-schema-explorer');
    this.title.label = 'Schema Explorer';
    this.title.closable = true;
  }

  async refresh(): Promise<void> {
    try {
      const resp = await this._commClient.request('schema_roots');
      this._nodes = ((resp as any).nodes || []).map((n: any) => ({
        ...n,
        children: [],
        expanded: false,
      }));
      this._render();
    } catch (e) {
      this.node.innerHTML = '<p class="hugr-empty">No schema available</p>';
    }
  }

  private _render(): void {
    const searchHtml = `<div class="hugr-schema-search">
      <input type="text" placeholder="Search types..." class="hugr-search-input" />
    </div>`;

    const tree = this._renderNodes(this._nodes);
    const searchResults = '<div class="hugr-schema-results"></div>';

    this.node.innerHTML = `${searchHtml}<div class="hugr-tree">${tree}</div>${searchResults}`;

    this.node.querySelector('.hugr-search-input')?.addEventListener('input', (e) => {
      const query = (e.target as HTMLInputElement).value;
      if (query.length >= 2) this._search(query);
    });

    this._attachHandlers();
  }

  private _renderNodes(nodes: SchemaNode[], indent = 0): string {
    return nodes.map(n => {
      const expandIcon = n.hasChildren ? (n.expanded ? '▼' : '▶') : ' ';
      const desc = n.description ? ` <span class="hugr-node-desc">${escapeHtml(n.description)}</span>` : '';
      const children = n.expanded && n.children?.length
        ? this._renderNodes(n.children, indent + 1)
        : '';
      return `
        <div class="hugr-tree-node" data-id="${escapeHtml(n.id)}" style="padding-left:${indent * 16}px">
          <span class="hugr-node-expand" data-id="${escapeHtml(n.id)}">${expandIcon}</span>
          <span class="hugr-node-label">${escapeHtml(n.label)}</span>${desc}
        </div>
        ${children}
      `;
    }).join('');
  }

  private _attachHandlers(): void {
    this.node.querySelectorAll('.hugr-node-expand').forEach(el => {
      el.addEventListener('click', async (e) => {
        const id = (e.target as HTMLElement).dataset.id;
        if (id) await this._toggleNode(id);
      });
    });
  }

  private _findNode(id: string, nodes: SchemaNode[] = this._nodes): SchemaNode | null {
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
        // Get the type name from metadata or id
        const typeName = node.metadata?.typeName || node.id.replace('type:', '').replace(/^field:.+\./, '');
        if (typeName) {
          const resp = await this._commClient.request('schema_children', { type_name: typeName });
          node.children = ((resp as any).nodes || []).map((n: any) => ({
            ...n,
            children: [],
            expanded: false,
          }));
        }
      }
      node.expanded = true;
    }
    this._render();
  }

  private async _search(query: string): Promise<void> {
    try {
      const resp = await this._commClient.request('schema_types', { query, limit: 20 });
      const types = (resp as any).types || [];
      const resultsEl = this.node.querySelector('.hugr-schema-results');
      if (resultsEl) {
        if (types.length === 0) {
          resultsEl.innerHTML = '<p>No types found</p>';
        } else {
          resultsEl.innerHTML = `<table class="hugr-type-table">
            <thead><tr><th>Name</th><th>Kind</th><th>Description</th></tr></thead>
            <tbody>${types.map((t: any) =>
              `<tr><td>${escapeHtml(t.name)}</td><td>${escapeHtml(t.kind)}</td><td>${escapeHtml(t.description || '')}</td></tr>`
            ).join('')}</tbody>
          </table>`;
        }
      }
    } catch (e) {
      console.debug('Schema search failed', e);
    }
  }
}
