/**
 * Comm-based client for communicating with the hugr kernel.
 *
 * Uses Jupyter comm protocol (comm_open / comm_msg) instead of HTTP,
 * avoiding CORS issues entirely. All messages flow through the existing
 * Jupyter WebSocket connection.
 */

import type { Kernel } from '@jupyterlab/services';

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

type PendingRequest = {
  resolve: (data: Record<string, any>) => void;
  reject: (err: Error) => void;
};

/**
 * Client that communicates with the hugr kernel via Jupyter comm messages.
 */
export class CommClient {
  private comm: Kernel.IComm | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private disposed = false;
  private onConnectionsChanged: (() => void) | null = null;

  constructor(private kernel: Kernel.IKernelConnection) {}

  /** Set a callback for when connections change. */
  setOnConnectionsChanged(cb: (() => void) | null): void {
    this.onConnectionsChanged = cb;
  }

  /** Open the comm channel. Must be called before any requests. */
  async open(): Promise<void> {
    this.comm = this.kernel.createComm('hugr.explorer');
    this.comm.onMsg = (msg: any) => {
      const data = msg.content.data as Record<string, any>;
      if (data?.type === 'response' && data?.request_id) {
        const pending = this.pending.get(data.request_id);
        if (pending) {
          this.pending.delete(data.request_id);
          if (data.error) {
            pending.reject(new Error(data.error as string));
          } else {
            pending.resolve(data);
          }
        }
      }
    };
    this.comm.onClose = () => {
      this.comm = null;
      // Reject all pending requests
      for (const [, p] of this.pending) {
        p.reject(new Error('comm closed'));
      }
      this.pending.clear();
    };
    await this.comm.open().done;
  }

  /** Close the comm channel. */
  close(): void {
    this.disposed = true;
    if (this.comm) {
      void this.comm.close();
      this.comm = null;
    }
    for (const [, p] of this.pending) {
      p.reject(new Error('client disposed'));
    }
    this.pending.clear();
  }

  /** Send a request and wait for the matching response. */
  private request(
    type: string,
    data?: Record<string, any>,
    timeoutMs = 10000,
  ): Promise<Record<string, any>> {
    if (!this.comm || this.disposed) {
      return Promise.reject(new Error('comm not open'));
    }

    const requestId = `req_${++this.requestCounter}`;
    const payload: Record<string, any> = { type, request_id: requestId, ...data };

    return new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`request ${type} timed out`));
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.comm!.send(payload);
    });
  }

  // ---- Connection management ----

  async connections(): Promise<ConnectionStatus[]> {
    const resp = await this.request('connections');
    return (resp.connections as ConnectionStatus[]) || [];
  }

  async addConnection(name: string, url: string): Promise<void> {
    await this.request('add_connection', { name, url });
    this.onConnectionsChanged?.();
  }

  async removeConnection(name: string): Promise<void> {
    await this.request('remove_connection', { name });
    this.onConnectionsChanged?.();
  }

  async setDefault(name: string): Promise<void> {
    await this.request('set_default', { name });
    this.onConnectionsChanged?.();
  }

  // ---- Logical explorer ----

  async logicalRoots(): Promise<ExplorerNode[]> {
    const resp = await this.request('logical_roots');
    return (resp.nodes as ExplorerNode[]) || [];
  }

  async modules(): Promise<ExplorerNode[]> {
    const resp = await this.request('modules');
    return (resp.nodes as ExplorerNode[]) || [];
  }

  async logicalChildren(nodeId: string, search?: string): Promise<ExplorerNode[]> {
    const resp = await this.request('logical_children', { id: nodeId, search });
    return (resp.nodes as ExplorerNode[]) || [];
  }

  // ---- Schema explorer ----

  async schemaTypes(
    kind?: string,
    search?: string,
    limit?: number,
    offset?: number,
  ): Promise<{ nodes: ExplorerNode[]; total: number }> {
    const resp = await this.request('schema_types', { kind, search, limit, offset });
    return { nodes: (resp.nodes as ExplorerNode[]) || [], total: (resp.total as number) || 0 };
  }

  async schemaChildren(nodeId: string): Promise<ExplorerNode[]> {
    const resp = await this.request('schema_children', { id: nodeId });
    return (resp.nodes as ExplorerNode[]) || [];
  }

  // ---- Schema roots ----

  async schemaRoots(): Promise<ExplorerNode[]> {
    const resp = await this.request('schema_roots');
    return (resp.nodes as ExplorerNode[]) || [];
  }

  // ---- Detail & Search ----

  async detail(nodeId: string): Promise<EntityDetail> {
    const resp = await this.request('detail', { id: nodeId });
    return resp.detail as EntityDetail;
  }

  async search(query: string, scope?: string, limit?: number): Promise<ExplorerNode[]> {
    const resp = await this.request('search', { q: query, scope, limit });
    return (resp.results as ExplorerNode[]) || [];
  }
}
