/**
 * HTTP client for the kernel's /explorer/* endpoints.
 * Browser-side (JupyterLab runs in browser, so uses fetch API).
 */

export interface ConnectionStatus {
  name: string;
  url: string;
  active: boolean;
  version?: string;
  cluster_mode?: boolean;
  node_role?: string;
}

export interface ExplorerNode {
  id: string;
  label: string;
  kind: string;
  description: string;
  hasChildren: boolean;
  parentId?: string;
  metadata?: Record<string, any>;
}

export interface DetailSection {
  title: string;
  kind: 'Table' | 'List' | 'Text' | 'Code';
  columns?: string[];
  rows?: string[][];
  items?: string[];
  content?: string;
}

export interface EntityDetail {
  id: string;
  kind: string;
  name: string;
  description: string;
  longDescription?: string;
  sections: DetailSection[];
}

export class ExplorerClient {
  constructor(private baseUrl: string) {}

  private async fetchJSON<T>(path: string, params?: Record<string, string>): Promise<T> {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    const url = `${this.baseUrl}${path}${query}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async connections(): Promise<ConnectionStatus[]> {
    const resp = await this.fetchJSON<{ connections: ConnectionStatus[] }>('/explorer/connections');
    return resp.connections || [];
  }

  async logicalRoots(): Promise<ExplorerNode[]> {
    const resp = await this.fetchJSON<{ nodes: ExplorerNode[] }>('/explorer/logical');
    return resp.nodes || [];
  }

  async logicalChildren(nodeId: string, search?: string): Promise<ExplorerNode[]> {
    const params: Record<string, string> = { id: nodeId };
    if (search) params.search = search;
    const resp = await this.fetchJSON<{ nodes: ExplorerNode[] }>('/explorer/logical/children', params);
    return resp.nodes || [];
  }

  async schemaTypes(kind?: string, search?: string, limit?: number, offset?: number): Promise<{ nodes: ExplorerNode[]; total: number }> {
    const params: Record<string, string> = {};
    if (kind) params.kind = kind;
    if (search) params.search = search;
    if (limit) params.limit = String(limit);
    if (offset) params.offset = String(offset);
    const resp = await this.fetchJSON<{ nodes: ExplorerNode[]; total: number }>('/explorer/schema', params);
    return { nodes: resp.nodes || [], total: resp.total || 0 };
  }

  async schemaChildren(nodeId: string): Promise<ExplorerNode[]> {
    const resp = await this.fetchJSON<{ nodes: ExplorerNode[] }>('/explorer/schema/children', { id: nodeId });
    return resp.nodes || [];
  }

  async detail(nodeId: string): Promise<EntityDetail> {
    return this.fetchJSON<EntityDetail>('/explorer/detail', { id: nodeId });
  }

  async search(query: string, scope?: string, limit?: number): Promise<ExplorerNode[]> {
    const params: Record<string, string> = { q: query };
    if (scope) params.scope = scope;
    if (limit) params.limit = String(limit);
    const resp = await this.fetchJSON<{ results: ExplorerNode[] }>('/explorer/search', params);
    return resp.results || [];
  }
}
