/**
 * HugrClient — GraphQL client for VS Code extension.
 *
 * Communicates directly with Hugr servers using Node.js http/https,
 * handles multipart/mixed IPC responses (JSON + Arrow IPC), and manages
 * authentication headers.
 *
 * Ported from JupyterLab hugrClient.ts.
 */
import * as http from 'http';
import * as https from 'https';
import { tableFromIPC } from 'apache-arrow';

export interface HugrClientOptions {
  url: string;
  authType?: 'public' | 'api_key' | 'bearer';
  apiKey?: string;
  token?: string;
  timeout?: number;
}

export interface HugrResponse {
  data: Record<string, any>;
  errors: HugrError[];
  extensions: Record<string, any>;
}

export interface HugrError {
  message: string;
  path?: string[];
  extensions?: Record<string, any>;
}

/**
 * Set a nested value on an object given a dot-separated path.
 */
function setNested(
  target: Record<string, any>,
  path: string,
  value: any
): void {
  const segments = path.split('.');
  let current = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!(seg in current) || typeof current[seg] !== 'object') {
      current[seg] = {};
    }
    current = current[seg];
  }
  current[segments[segments.length - 1]] = value;
}

/**
 * Parse multipart/mixed response from binary buffer using --HUGR boundary.
 */
function parseMultipartBinary(raw: Buffer): Array<{
  headers: Record<string, string>;
  body: Buffer;
}> {
  const parts: Array<{ headers: Record<string, string>; body: Buffer }> = [];
  const delimiter = Buffer.from('--HUGR');
  const endMarker = Buffer.from('--HUGR--');

  // Find all delimiter positions
  const positions: number[] = [];
  for (let i = 0; i <= raw.length - delimiter.length; i++) {
    if (raw.subarray(i, i + delimiter.length).equals(delimiter)) {
      positions.push(i);
    }
  }

  if (positions.length < 2) return parts;

  for (let p = 0; p < positions.length - 1; p++) {
    // Check for end marker
    if (raw.subarray(positions[p], positions[p] + endMarker.length).equals(endMarker)) {
      break;
    }

    // Skip delimiter + trailing \r\n or \n
    let start = positions[p] + delimiter.length;
    if (raw[start] === 0x0d && raw[start + 1] === 0x0a) {
      start += 2;
    } else if (raw[start] === 0x0a) {
      start += 1;
    }

    let end = positions[p + 1];
    // Trim trailing \r\n before next delimiter
    if (end >= 2 && raw[end - 2] === 0x0d && raw[end - 1] === 0x0a) {
      end -= 2;
    } else if (end >= 1 && raw[end - 1] === 0x0a) {
      end -= 1;
    }

    const partBuf = raw.subarray(start, end);

    // Find blank line separating headers from body
    let headerEnd = -1;
    let bodyOffset = 0;
    for (let i = 0; i < partBuf.length - 1; i++) {
      if (partBuf[i] === 0x0a && partBuf[i + 1] === 0x0a) {
        headerEnd = i;
        bodyOffset = i + 2;
        break;
      }
      if (i < partBuf.length - 3 &&
        partBuf[i] === 0x0d && partBuf[i + 1] === 0x0a &&
        partBuf[i + 2] === 0x0d && partBuf[i + 3] === 0x0a) {
        headerEnd = i;
        bodyOffset = i + 4;
        break;
      }
    }

    if (headerEnd === -1) {
      parts.push({ headers: {}, body: partBuf });
      continue;
    }

    const headerText = partBuf.subarray(0, headerEnd).toString('utf-8');
    const headers: Record<string, string> = {};
    for (const line of headerText.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }

    const body = Buffer.from(partBuf.subarray(bodyOffset));
    parts.push({ headers, body });
  }

  return parts;
}

export class HugrClient {
  private _url: string;
  private _authType: 'public' | 'api_key' | 'bearer';
  private _apiKey?: string;
  private _token?: string;
  private _timeout: number;
  private _aborted = false;

  constructor(options: HugrClientOptions) {
    this._url = options.url;
    this._authType = options.authType ?? 'public';
    this._apiKey = options.apiKey;
    this._token = options.token;
    this._timeout = options.timeout ?? 10000;
  }

  get url(): string {
    return this._url;
  }

  abort(): void {
    this._aborted = true;
  }

  async query(
    graphql: string,
    variables?: Record<string, any>
  ): Promise<HugrResponse> {
    this._aborted = false;

    const body: Record<string, any> = { query: graphql };
    if (variables) {
      body.variables = variables;
    }
    const bodyStr = JSON.stringify(body);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(bodyStr)),
    };

    if (this._authType === 'api_key' && this._apiKey) {
      headers['X-Api-Key'] = this._apiKey;
    } else if (this._authType === 'bearer' && this._token) {
      headers['Authorization'] = `Bearer ${this._token}`;
    }

    const raw = await this._post(this._url, bodyStr, headers);
    return this._parseResponse(raw);
  }

  private _post(
    url: string,
    body: string,
    headers: Record<string, string>
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;

      const req = mod.request(parsed, {
        method: 'POST',
        headers,
        timeout: this._timeout,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.toString('utf-8').slice(0, 500)}`));
          } else {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Connection timeout'));
      });
      req.write(body);
      req.end();
    });
  }

  private _parseResponse(raw: Buffer): HugrResponse {
    const text = raw.toString('utf-8');

    // Check if it's a multipart response
    if (text.includes('--HUGR')) {
      return this._parseMultipartResponse(raw);
    }

    // Standard JSON response
    try {
      const json = JSON.parse(text);
      return {
        data: json.data ?? {},
        errors: json.errors ?? [],
        extensions: json.extensions ?? {},
      };
    } catch {
      return {
        data: {},
        errors: [{ message: `Invalid response: ${text.slice(0, 200)}` }],
        extensions: {},
      };
    }
  }

  private _parseMultipartResponse(raw: Buffer): HugrResponse {
    const parts = parseMultipartBinary(raw);
    const result: HugrResponse = {
      data: {},
      errors: [],
      extensions: {},
    };

    for (const part of parts) {
      const partType = part.headers['X-Hugr-Part-Type'];
      const format = part.headers['X-Hugr-Format'];
      const path = part.headers['X-Hugr-Path'];

      switch (partType) {
        case 'data': {
          let parsed: any;

          if (format === 'table') {
            // Arrow IPC stream → convert to array of JSON objects
            try {
              const table = tableFromIPC(part.body);
              // Use JSON round-trip with BigInt replacer to get plain JS objects.
              // Arrow returns Proxy objects and BigInt values that can't be
              // passed to postMessage/JSON.stringify directly.
              const rows = table.toArray();
              const jsonStr = JSON.stringify(rows, (_key, value) =>
                typeof value === 'bigint' ? Number(value) : value
              );
              parsed = JSON.parse(jsonStr);
            } catch {
              // Skip unparseable Arrow parts
              break;
            }
          } else {
            // JSON (object format)
            try {
              parsed = JSON.parse(part.body.toString('utf-8'));
            } catch {
              break;
            }
          }

          if (path) {
            setNested(result, path, parsed);
          } else {
            Object.assign(result.data, parsed);
          }
          break;
        }
        case 'errors': {
          try {
            const errs: HugrError[] = JSON.parse(part.body.toString('utf-8'));
            result.errors.push(...errs);
          } catch {
            result.errors.push({ message: part.body.toString('utf-8') });
          }
          break;
        }
        case 'extensions': {
          try {
            const ext = JSON.parse(part.body.toString('utf-8'));
            Object.assign(result.extensions, ext);
          } catch {}
          break;
        }
        default: {
          try {
            const parsed = JSON.parse(part.body.toString('utf-8'));
            Object.assign(result.data, parsed);
          } catch {}
          break;
        }
      }
    }

    return result;
  }
}
