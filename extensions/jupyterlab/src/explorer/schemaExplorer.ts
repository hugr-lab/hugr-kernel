/**
 * JupyterLab widget for the Hugr GraphQL schema explorer.
 *
 * Two sections:
 * 1. Root type tree (Query, Mutation) — lazy-loads fields recursively
 * 2. Type browser — search-only sections for types/directives (hidden until search)
 */

import { Widget } from '@lumino/widgets';
import { CommClient, ExplorerNode } from '../commClient.js';
import { SearchBar } from './searchBar.js';
import { showDetailModal } from './detailModal.js';

/* ========== helpers ========== */

function esc(text: unknown): string {
  const el = document.createElement('span');
  el.textContent = String(text ?? '');
  return el.innerHTML;
}

/* ========== tree node factory ========== */

function createFieldNode(
  node: ExplorerNode,
  client: CommClient,
): HTMLElement {
  const item = document.createElement('div');
  item.className = 'hugr-tree-item';

  const row = document.createElement('div');
  row.className = 'hugr-tree-row';

  // Toggle
  const toggle = document.createElement('span');
  toggle.className = 'hugr-tree-toggle';
  toggle.textContent = node.hasChildren ? '\u25B6' : ' ';
  row.appendChild(toggle);

  // Label (field name)
  const label = document.createElement('span');
  label.className = 'hugr-tree-label';
  label.textContent = node.label;
  if (node.description) {
    label.title = node.description;
  }
  row.appendChild(label);

  // Type annotation (dimmed)
  if (node.metadata?.type) {
    const typeEl = document.createElement('span');
    typeEl.className = 'hugr-tree-desc';
    typeEl.textContent = node.metadata.type as string;
    row.appendChild(typeEl);
  }

  // Info button
  const infoBtn = document.createElement('button');
  infoBtn.className = 'hugr-info-btn';
  infoBtn.textContent = '\u2139';
  infoBtn.title = `Details: ${node.label}`;
  infoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void showDetailModal(client, node.id);
  });
  row.appendChild(infoBtn);

  item.appendChild(row);

  // Children container
  const childrenEl = document.createElement('div');
  childrenEl.className = 'hugr-tree-children';
  childrenEl.style.display = 'none';
  item.appendChild(childrenEl);

  let loaded = false;

  if (node.hasChildren) {
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const isOpen = childrenEl.style.display !== 'none';
      if (isOpen) {
        childrenEl.style.display = 'none';
        toggle.textContent = '\u25B6';
      } else {
        childrenEl.style.display = 'block';
        toggle.textContent = '\u25BC';
        if (!loaded) {
          loaded = true;
          // For fields, expand the return type
          const returnTypeName = node.metadata?.returnTypeName as string;
          if (returnTypeName) {
            void loadTypeChildren(client, 'type:' + returnTypeName, childrenEl);
          }
        }
      }
    });
  }

  return item;
}

async function loadTypeChildren(
  client: CommClient,
  typeId: string,
  container: HTMLElement,
): Promise<void> {
  container.innerHTML = '<div class="hugr-loading">Loading...</div>';

  try {
    const children = await client.schemaChildren(typeId);
    container.innerHTML = '';

    if (children.length === 0) {
      container.innerHTML = '<div class="hugr-empty">(no fields)</div>';
      return;
    }

    for (const child of children) {
      container.appendChild(createFieldNode(child, client));
    }
  } catch (err: any) {
    container.innerHTML = `<div class="hugr-error">${esc(err.message)}</div>`;
  }
}

/* ========== main widget ========== */

const PAGE_SIZE = 20;

export class HugrSchemaExplorer extends Widget {
  private client: CommClient | null = null;
  private searchBar: SearchBar;
  private rootTreeEl: HTMLElement;
  private searchResultsEl: HTMLElement;
  private currentSearch = '';

  constructor() {
    super();
    this.addClass('hugr-schema-explorer');
    this.id = 'hugr-schema-explorer';
    this.title.label = 'Schema';
    this.title.caption = 'Hugr GraphQL Schema Explorer';
    this.title.closable = true;

    // Header
    const header = document.createElement('div');
    header.className = 'hugr-explorer-header';
    header.innerHTML = '<span class="hugr-explorer-title">GraphQL Schema</span>';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'hugr-refresh-btn';
    refreshBtn.textContent = '\u21BB';
    refreshBtn.title = 'Refresh schema';
    refreshBtn.addEventListener('click', () => void this.refresh());
    header.appendChild(refreshBtn);

    this.node.appendChild(header);

    // Search bar
    this.searchBar = new SearchBar({
      placeholder: 'Search types...',
      onSearch: (query) => {
        this.currentSearch = query;
        if (query) {
          this.rootTreeEl.style.display = 'none';
          this.searchResultsEl.style.display = 'block';
          void this.loadSearchResults(query);
        } else {
          this.rootTreeEl.style.display = 'block';
          this.searchResultsEl.style.display = 'none';
          this.searchResultsEl.innerHTML = '';
        }
      },
    });
    this.node.appendChild(this.searchBar.node);

    // Root type tree container
    this.rootTreeEl = document.createElement('div');
    this.rootTreeEl.className = 'hugr-explorer-tree';
    this.node.appendChild(this.rootTreeEl);

    // Search results container (hidden by default)
    this.searchResultsEl = document.createElement('div');
    this.searchResultsEl.className = 'hugr-schema-content';
    this.searchResultsEl.style.display = 'none';
    this.node.appendChild(this.searchResultsEl);
  }

  setClient(client: CommClient | null): void {
    this.client = client;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.client) {
      this.rootTreeEl.innerHTML =
        '<div class="hugr-explorer-placeholder">No active Hugr kernel</div>';
      return;
    }
    await this.loadRootTree();
  }

  /* ==================== root type tree ==================== */

  private async loadRootTree(): Promise<void> {
    if (!this.client) return;

    this.rootTreeEl.innerHTML = '<div class="hugr-loading">Loading...</div>';

    try {
      const roots = await this.client.schemaRoots();
      this.rootTreeEl.innerHTML = '';

      if (roots.length === 0) {
        this.rootTreeEl.innerHTML =
          '<div class="hugr-empty">No root types found.</div>';
        return;
      }

      for (const root of roots) {
        this.rootTreeEl.appendChild(this.createRootTypeNode(root));
      }
    } catch (err: any) {
      this.rootTreeEl.innerHTML =
        `<div class="hugr-error">${esc(err.message)}</div>`;
    }
  }

  private createRootTypeNode(node: ExplorerNode): HTMLElement {
    const item = document.createElement('div');
    item.className = 'hugr-tree-item';

    const row = document.createElement('div');
    row.className = 'hugr-tree-row hugr-root-type-row';

    const toggle = document.createElement('span');
    toggle.className = 'hugr-tree-toggle';
    toggle.textContent = '\u25B6';
    row.appendChild(toggle);

    const label = document.createElement('span');
    label.className = 'hugr-tree-label hugr-root-type-label';
    label.textContent = node.label; // "query", "mutation", etc.
    row.appendChild(label);

    const typeName = document.createElement('span');
    typeName.className = 'hugr-tree-desc';
    typeName.textContent = node.description; // actual type name
    row.appendChild(typeName);

    item.appendChild(row);

    const childrenEl = document.createElement('div');
    childrenEl.className = 'hugr-tree-children';
    childrenEl.style.display = 'none';
    item.appendChild(childrenEl);

    let loaded = false;

    row.addEventListener('click', () => {
      const isOpen = childrenEl.style.display !== 'none';
      if (isOpen) {
        childrenEl.style.display = 'none';
        toggle.textContent = '\u25B6';
      } else {
        childrenEl.style.display = 'block';
        toggle.textContent = '\u25BC';
        if (!loaded && this.client) {
          loaded = true;
          void loadTypeChildren(this.client, node.id, childrenEl);
        }
      }
    });

    return item;
  }

  /* ==================== search results ==================== */

  private async loadSearchResults(query: string): Promise<void> {
    if (!this.client) return;

    this.searchResultsEl.innerHTML = '<div class="hugr-loading">Searching...</div>';

    try {
      const result = await this.client.schemaTypes(
        undefined,
        query,
        PAGE_SIZE,
        0,
      );
      this.searchResultsEl.innerHTML = '';

      if (result.nodes.length === 0) {
        this.searchResultsEl.innerHTML =
          '<div class="hugr-empty">No types matching "' + esc(query) + '"</div>';
        return;
      }

      // Render as a simple table
      const table = document.createElement('table');
      table.className = 'hugr-table';

      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const col of ['Name', 'Kind', 'Description']) {
        const th = document.createElement('th');
        th.textContent = col;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const typeNode of result.nodes) {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.title = 'Click for details';

        const tdName = document.createElement('td');
        tdName.textContent = typeNode.label;
        tr.appendChild(tdName);

        const tdKind = document.createElement('td');
        tdKind.textContent = (typeNode.metadata?.graphqlKind as string) ?? '';
        tr.appendChild(tdKind);

        const tdDesc = document.createElement('td');
        tdDesc.textContent = typeNode.description || '';
        tr.appendChild(tdDesc);

        tr.addEventListener('click', () => {
          if (this.client) {
            void showDetailModal(this.client, typeNode.id);
          }
        });

        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      const wrapper = document.createElement('div');
      wrapper.className = 'hugr-detail-table-wrap';
      wrapper.appendChild(table);
      this.searchResultsEl.appendChild(wrapper);

      // Load more
      const loaded = result.nodes.length;
      if (loaded < result.total) {
        const moreBtn = document.createElement('button');
        moreBtn.className = 'hugr-load-more-btn';
        moreBtn.textContent = `Showing ${loaded} of ${result.total} — load more`;
        moreBtn.addEventListener('click', () => {
          moreBtn.remove();
          void this.loadMoreSearchResults(query, tbody, loaded, result.total);
        });
        this.searchResultsEl.appendChild(moreBtn);
      }
    } catch (err: any) {
      this.searchResultsEl.innerHTML =
        `<div class="hugr-error">${esc(err.message)}</div>`;
    }
  }

  private async loadMoreSearchResults(
    query: string,
    tbody: HTMLTableSectionElement,
    offset: number,
    total: number,
  ): Promise<void> {
    if (!this.client) return;

    try {
      const result = await this.client.schemaTypes(
        undefined,
        query,
        PAGE_SIZE,
        offset,
      );

      for (const typeNode of result.nodes) {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.title = 'Click for details';

        const tdName = document.createElement('td');
        tdName.textContent = typeNode.label;
        tr.appendChild(tdName);

        const tdKind = document.createElement('td');
        tdKind.textContent = (typeNode.metadata?.graphqlKind as string) ?? '';
        tr.appendChild(tdKind);

        const tdDesc = document.createElement('td');
        tdDesc.textContent = typeNode.description || '';
        tr.appendChild(tdDesc);

        tr.addEventListener('click', () => {
          if (this.client) {
            void showDetailModal(this.client, typeNode.id);
          }
        });

        tbody.appendChild(tr);
      }

      const loaded = offset + result.nodes.length;
      if (loaded < total) {
        const moreBtn = document.createElement('button');
        moreBtn.className = 'hugr-load-more-btn';
        moreBtn.textContent = `Showing ${loaded} of ${total} — load more`;
        moreBtn.addEventListener('click', () => {
          moreBtn.remove();
          void this.loadMoreSearchResults(query, tbody, loaded, total);
        });
        this.searchResultsEl.parentElement?.appendChild(moreBtn);
      }
    } catch (err: any) {
      console.error('[hugr] load more search results error:', err);
    }
  }
}
