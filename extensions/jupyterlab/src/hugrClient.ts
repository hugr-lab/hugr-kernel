/**
 * HugrClient — GraphQL client that communicates directly with Hugr servers,
 * handles multipart/mixed IPC responses (JSON + Arrow), and manages
 * authentication headers.
 */
import { tableFromIPC } from 'apache-arrow';

export interface HugrClientOptions {
  /** Proxy URL: /hugr/proxy/{connectionName} */
  url: string;
  authType: 'public' | 'api_key' | 'bearer';
  apiKey?: string;
  token?: string;
  role?: string;
  /** Request timeout in milliseconds, default 10000 */
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

interface MultipartPart {
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * Read the _xsrf cookie value that Jupyter requires on non-GET requests.
 */
function getXsrfToken(): string | undefined {
  const match = document.cookie
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith('_xsrf='));
  return match ? decodeURIComponent(match.split('=')[1]) : undefined;
}

/**
 * Parse a multipart/mixed response body using the given boundary string.
 *
 * The format follows RFC 2046: parts are separated by `--BOUNDARY`,
 * each part has headers (key: value) followed by a blank line and the body.
 * The final boundary marker is `--BOUNDARY--`.
 */
export function parseMultipart(
  buffer: ArrayBuffer,
  boundary: string
): MultipartPart[] {
  const raw = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const endMarker = new TextEncoder().encode(`--${boundary}--`);

  const parts: MultipartPart[] = [];

  // Find all delimiter positions
  const positions: number[] = [];
  for (let i = 0; i <= raw.length - delimiter.length; i++) {
    let match = true;
    for (let j = 0; j < delimiter.length; j++) {
      if (raw[i + j] !== delimiter[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      positions.push(i);
    }
  }

  if (positions.length < 2) {
    return parts;
  }

  for (let p = 0; p < positions.length - 1; p++) {
    // Start after the delimiter + any trailing \r\n
    let start = positions[p] + delimiter.length;
    // Check for end marker at this position
    let isEnd = true;
    for (let j = 0; j < endMarker.length; j++) {
      if (raw[positions[p] + j] !== endMarker[j]) {
        isEnd = false;
        break;
      }
    }
    if (isEnd) {
      break;
    }

    // Skip \r\n or \n after delimiter
    if (raw[start] === 0x0d && raw[start + 1] === 0x0a) {
      start += 2;
    } else if (raw[start] === 0x0a) {
      start += 1;
    }

    const end = positions[p + 1];

    // Extract the part slice (trim trailing \r\n before next delimiter)
    let partEnd = end;
    if (partEnd >= 2 && raw[partEnd - 2] === 0x0d && raw[partEnd - 1] === 0x0a) {
      partEnd -= 2;
    } else if (partEnd >= 1 && raw[partEnd - 1] === 0x0a) {
      partEnd -= 1;
    }

    const partBytes = raw.slice(start, partEnd);

    // Find the blank line separating headers from body
    let headerEnd = -1;
    for (let i = 0; i < partBytes.length - 1; i++) {
      // \n\n
      if (partBytes[i] === 0x0a && partBytes[i + 1] === 0x0a) {
        headerEnd = i;
        break;
      }
      // \r\n\r\n
      if (
        i < partBytes.length - 3 &&
        partBytes[i] === 0x0d &&
        partBytes[i + 1] === 0x0a &&
        partBytes[i + 2] === 0x0d &&
        partBytes[i + 3] === 0x0a
      ) {
        headerEnd = i;
        break;
      }
    }

    if (headerEnd === -1) {
      // No blank line found — treat everything as body with no headers
      parts.push({ headers: {}, body: partBytes });
      continue;
    }

    const headerText = decoder.decode(partBytes.slice(0, headerEnd));
    const headers: Record<string, string> = {};
    for (const line of headerText.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        headers[key] = value;
      }
    }

    // Body starts after the blank line
    let bodyStart = headerEnd + 2; // \n\n
    if (
      headerEnd < partBytes.length - 3 &&
      partBytes[headerEnd] === 0x0d
    ) {
      bodyStart = headerEnd + 4; // \r\n\r\n
    }

    const body = partBytes.slice(bodyStart);
    parts.push({ headers, body });
  }

  return parts;
}

/**
 * Set a nested value on an object given a dot-separated path.
 * e.g. setNested(obj, "data.__type", value) → obj.data.__type = value
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

export class HugrClient {
  private _url: string;
  private _authType: 'public' | 'api_key' | 'bearer';
  private _apiKey?: string;
  private _token?: string;
  private _role?: string;
  private _timeout: number;
  private _controllers: Set<AbortController> = new Set();

  constructor(options: HugrClientOptions) {
    this._url = options.url;
    this._authType = options.authType;
    this._apiKey = options.apiKey;
    this._token = options.token;
    this._role = options.role;
    this._timeout = options.timeout ?? 10000;
  }

  /**
   * Update authentication credentials.
   */
  setAuth(authType: string, credential?: string): void {
    this._authType = authType as HugrClientOptions['authType'];
    if (authType === 'api_key') {
      this._apiKey = credential;
      this._token = undefined;
    } else if (authType === 'bearer') {
      this._token = credential;
      this._apiKey = undefined;
    } else {
      this._apiKey = undefined;
      this._token = undefined;
    }
  }

  /**
   * Cancel any in-flight request.
   */
  abort(): void {
    for (const c of this._controllers) {
      c.abort();
    }
    this._controllers.clear();
  }

  /**
   * Execute a GraphQL query against the Hugr server.
   */
  async query(
    graphql: string,
    variables?: Record<string, any>
  ): Promise<HugrResponse> {
    const controller = new AbortController();
    this._controllers.add(controller);

    const timeoutId = setTimeout(() => controller.abort(), this._timeout);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };

      // Auth headers
      if (this._authType === 'api_key' && this._apiKey) {
        headers['X-Api-Key'] = this._apiKey;
      } else if (this._authType === 'bearer' && this._token) {
        headers['Authorization'] = `Bearer ${this._token}`;
      }

      // Role header
      if (this._role) {
        headers['X-Hugr-Role'] = this._role;
      }

      // Jupyter XSRF token
      const xsrf = getXsrfToken();
      if (xsrf) {
        headers['X-XSRFToken'] = xsrf;
      }

      const body: Record<string, any> = { query: graphql };
      if (variables) {
        body.variables = variables;
      }

      const response = await fetch(this._url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const contentType = response.headers.get('Content-Type') || '';

      if (contentType.includes('multipart/mixed')) {
        return this._parseMultipartResponse(await response.arrayBuffer());
      }

      // Standard JSON response
      const json = await response.json();
      return {
        data: json.data ?? {},
        errors: json.errors ?? [],
        extensions: json.extensions ?? {}
      };
    } finally {
      clearTimeout(timeoutId);
      this._controllers.delete(controller);
    }
  }

  /**
   * Parse a multipart/mixed response into a unified HugrResponse.
   */
  private _parseMultipartResponse(buffer: ArrayBuffer): HugrResponse {
    const parts = parseMultipart(buffer, 'HUGR');
    const decoder = new TextDecoder();

    const result: HugrResponse = {
      data: {},
      errors: [],
      extensions: {}
    };

    for (const part of parts) {
      const partType = part.headers['X-Hugr-Part-Type'];
      const format = part.headers['X-Hugr-Format'];

      switch (partType) {
        case 'data': {
          const path = part.headers['X-Hugr-Path'];
          let parsed: any;

          if (format === 'table') {
            // Arrow IPC stream → convert to array of JSON objects
            const table = tableFromIPC(part.body);
            parsed = table.toArray().map((row: any) => {
              if (typeof row.toJSON === 'function') {
                return row.toJSON();
              }
              // Fallback: iterate over schema fields
              const obj: Record<string, any> = {};
              for (const field of table.schema.fields) {
                obj[field.name] = row[field.name];
              }
              return obj;
            });
          } else {
            // JSON (object format)
            const text = decoder.decode(part.body);
            parsed = JSON.parse(text);
          }

          if (path) {
            setNested(result, path, parsed);
          } else {
            Object.assign(result.data, parsed);
          }
          break;
        }
        case 'errors': {
          const text = decoder.decode(part.body);
          const errs: HugrError[] = JSON.parse(text);
          result.errors.push(...errs);
          break;
        }
        case 'extensions': {
          const text = decoder.decode(part.body);
          const ext = JSON.parse(text);
          Object.assign(result.extensions, ext);
          break;
        }
        default: {
          const text = decoder.decode(part.body);
          try {
            const parsed = JSON.parse(text);
            Object.assign(result.data, parsed);
          } catch {
            // Ignore unparseable parts
          }
          break;
        }
      }
    }

    return result;
  }
}
