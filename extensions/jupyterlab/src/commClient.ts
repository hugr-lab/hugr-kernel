/**
 * Comm protocol client for hugr.explorer communication.
 */
import { ISessionContext } from '@jupyterlab/apputils';
import { Kernel, KernelMessage } from '@jupyterlab/services';

export interface ExplorerRequest {
  type: string;
  request_id: string;
  [key: string]: any;
}

export interface ExplorerResponse {
  type: 'response' | 'error';
  request_id: string;
  request_type: string;
  error?: string;
  [key: string]: any;
}

export class CommClient {
  private _comm: Kernel.IComm | null = null;
  private _pending: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }> = new Map();
  private _requestCounter = 0;

  async connect(kernel: Kernel.IKernelConnection): Promise<void> {
    this._comm = kernel.createComm('hugr.explorer');
    await this._comm.open();
    this._comm.onMsg = (msg: KernelMessage.ICommMsgMsg) => {
      const data = msg.content.data as unknown as ExplorerResponse;
      const pending = this._pending.get(data.request_id);
      if (pending) {
        this._pending.delete(data.request_id);
        if (data.type === 'error') {
          pending.reject(new Error(data.error || 'Unknown error'));
        } else {
          pending.resolve(data);
        }
      }
    };
  }

  async request(type: string, params: Record<string, any> = {}): Promise<ExplorerResponse> {
    if (!this._comm) {
      throw new Error('Not connected');
    }
    const request_id = `req_${++this._requestCounter}`;
    const data: ExplorerRequest = { type, request_id, ...params };

    return new Promise((resolve, reject) => {
      this._pending.set(request_id, { resolve, reject });
      this._comm!.send(data as any);
      // Timeout after 30s
      setTimeout(() => {
        if (this._pending.has(request_id)) {
          this._pending.delete(request_id);
          reject(new Error(`Request ${type} timed out`));
        }
      }, 30000);
    });
  }

  dispose(): void {
    if (this._comm) {
      this._comm.close();
      this._comm = null;
    }
    this._pending.clear();
  }
}
