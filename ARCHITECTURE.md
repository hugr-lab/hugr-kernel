# Architecture

This document describes the architecture of the Hugr GraphQL Kernel, its IDE extensions, and how they interact.

## Overview

The system has three layers:

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (IDE)                          │
│  ┌──────────────────────┐  ┌─────────────────────────────┐  │
│  │   JupyterLab Ext     │  │      VS Code Extension      │  │
│  │  (CodeMirror 6 +     │  │  (TreeView + WebviewPanel +  │  │
│  │   Lumino widgets)    │  │   WebviewViewProvider)       │  │
│  └──────────┬───────────┘  └──────────────┬──────────────┘  │
│             │                             │                 │
│             │  Jupyter protocol           │  Direct HTTP    │
│             │  (complete/inspect)         │  (GraphQL)      │
├─────────────┼─────────────────────────────┼─────────────────┤
│             │      Kernel (Go)            │                 │
│  ┌──────────▼───────────────────┐         │                 │
│  │  hugr-kernel                 │         │                 │
│  │  ZMQ ↔ Jupyter wire protocol │         │                 │
│  │  Meta commands, sessions     │         │                 │
│  └──────────┬───────────────────┘         │                 │
├─────────────┼─────────────────────────────┼─────────────────┤
│             │      Hugr Server            │                 │
│  ┌──────────▼─────────────────────────────▼──────────────┐  │
│  │  Hugr IPC endpoint (/ipc)                             │  │
│  │  Multipart response: JSON + Arrow IPC tables          │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Key design principle**: The kernel is a **thin orchestration layer**. It does not duplicate Hugr client logic, does not load full datasets into memory, and does not render UI. Query execution is delegated to the Hugr Go client; rendering is the frontend's responsibility.

## Kernel (Go)

### Package Structure

```
cmd/hugr-kernel/
  main.go                    Entry point, CLI flags, signal handling, watchdog

internal/kernel/
  kernel.go                  ZMQ socket management, message loops, heartbeat
  message.go                 Jupyter wire protocol v5.0 (header, content, HMAC)
  handlers.go                Shell message handlers: execute_request, complete_request,
                             inspect_request, kernel_info_request
  arrowhttp.go               Arrow IPC HTTP streaming server for large results

internal/connection/
  connection.go              Connection struct wrapping the Hugr Go client
  manager.go                 ConnectionManager: add, remove, set default, list

internal/session/
  session.go                 Session variables ($var substitution), execution counter

internal/meta/
  parser.go                  Meta command parser (: prefix detection)
  registry.go                Command registry and dispatch
  commands.go                14 meta command implementations (:connect, :use, :auth, etc.)

internal/result/
  handler.go                 Multipart Hugr response → MIME bundles for Jupyter
  spool.go                   Arrow IPC file spool (temp files for streaming)

internal/renderer/
  table.go                   ASCII table fallback for text/plain output

internal/schema/
  client.go                  Schema introspection client with TTL cache
  queries.go                 Introspection queries for types, fields, directives
  resolve.go                 Type resolution and field path lookup

internal/completion/
  completer.go               GraphQL autocomplete: fields, args, types, directives, variables
  context.go                 CursorContext struct and ContextKind constants
  astwalker.go               AST walk algorithm to determine cursor context
  parseutil.go               SafeParse wrapper (partial AST from incomplete input)

internal/hover/
  hover.go                   Hover information: type details, field descriptions

internal/debug/
  debug.go                   Debug logging utilities
```

### Execution Flow

```
Cell input
  │
  ├── starts with ":"  →  Meta command parser  →  Command registry  →  Execute
  │
  └── GraphQL query    →  Connection manager (get active connection)
                            │
                            ▼
                       Hugr Go client.Execute()
                            │
                            ▼
                       Hugr IPC endpoint (multipart response)
                            │
                            ▼
                       Result handler:
                         ├── JSON parts    →  application/vnd.hugr.result+json
                         ├── Arrow tables  →  Spool to temp files → HTTP streaming
                         └── Errors        →  Jupyter error output
```

### IDE Protocol

The kernel handles two Jupyter protocol messages for IDE features:

- **`complete_request`** — Parses the GraphQL input up to cursor position using `gqlparser`, walks the AST to determine context (field, argument, directive, variable, etc.), then queries the schema cache for completions.
- **`inspect_request`** — Extracts the token at cursor position, resolves it against the cached schema, and returns type/field/directive documentation.

### Hugr IPC Protocol

The Hugr server returns responses in a custom multipart format:

```
--HUGR
X-Hugr-Part-Type: data
X-Hugr-Format: table
X-Hugr-Path: data.core.catalog.types

<Arrow IPC binary stream>
--HUGR
X-Hugr-Part-Type: data
X-Hugr-Format: json
X-Hugr-Path: data.core.info

{"version":"0.3.8"}
--HUGR--
```

**Headers per part:**
| Header | Values | Description |
|--------|--------|-------------|
| `X-Hugr-Part-Type` | `data`, `errors`, `extensions` | Part category |
| `X-Hugr-Format` | `json`, `table` | Encoding format |
| `X-Hugr-Path` | dot-separated path | Where to place data in the response tree |

**Binary parsing**: The boundary `--HUGR` is located by scanning raw bytes (not string splitting) to correctly handle Arrow IPC binary data within parts.

## JupyterLab Extension

### Package

`@hugr-lab/jupyterlab-graphql-ide` — TypeScript, CodeMirror 6, Lumino widgets.

### Structure

```
extensions/jupyterlab/src/
  plugin.ts                  JupyterLab plugin entry point, activation

  graphql/
    language.ts              CodeMirror 6 GraphQL language support
    completion.ts            Autocomplete provider (kernel complete_request)
    diagnostics.ts           Error diagnostics (lint)
    formatting.ts            Query formatting
    hover.ts                 Hover tooltips (kernel inspect_request)

  explorer/
    hugrExplorer.ts          Main explorer panel (Lumino SplitPanel)
    schemaTree.ts            Schema tree with lazy loading
    typesSearch.ts           Types search with pagination and semantic search
    directivesList.ts        Directives list with expandable args
    detailModal.ts           Type/directive detail modal
    icons.ts                 SVG icons and color mappings

  connectionManager.ts       Connection lifecycle (via server extension API)
  hugrClient.ts              GraphQL client with multipart IPC parsing
```

### IDE Features via Kernel Protocol

JupyterLab uses the standard Jupyter protocol for IDE features. When a user types in a notebook cell:

1. **Autocomplete** — CodeMirror sends `complete_request` to the kernel via Jupyter protocol. The kernel's `completer.go` parses the GraphQL, determines cursor context, and returns suggestions.
2. **Hover** — On mouse hover, `inspect_request` is sent. The kernel returns type/field documentation.
3. **Diagnostics** — Errors from query execution are displayed as CodeMirror lint markers.

### Explorer (Direct Connection)

The JupyterLab explorer connects **directly** to the Hugr server (not through the kernel) for schema browsing:

```
Explorer panel  →  hugrClient.ts  →  Hugr IPC endpoint (/ipc)
                                         │
                                         ▼
                                    Multipart response
                                    (JSON + Arrow IPC)
```

The connection URL comes from `~/.hugr/connections.json`, managed by the `hugr_connection_service` Jupyter server extension.

## VS Code Extension

### Package

`hugr-graphql-ide` — TypeScript, esbuild, VS Code API 1.80+.

### Structure

```
extensions/vscode/
  package.json               Extension manifest: views, commands, menus
  build.mjs                  esbuild bundler config
  resources/icons/            29 SVG icons (6 kind + 23 hugr type)

  src/
    extension.ts             Activation: registers providers, commands, event handlers
    connectionTreeProvider.ts TreeDataProvider for connections + file watcher

    explorer/
      hugrClient.ts          GraphQL client with binary multipart + Arrow IPC parsing
      schemaTreeProvider.ts  TreeDataProvider with lazy-loading schema tree
      directivesTreeProvider.ts  TreeDataProvider for directives list
      typesSearchProvider.ts WebviewViewProvider for types search sidebar
      detailPanel.ts         WebviewPanel for type/directive detail with navigation history
      icons.ts               Icon paths, inline SVGs, colors, type unwrapping
```

### Views

The extension contributes a sidebar with four views:

| View | Type | Provider | Description |
|------|------|----------|-------------|
| Connections | TreeView | `ConnectionTreeProvider` | Read/write `~/.hugr/connections.json`, file watcher for external changes |
| Schema | TreeView | `SchemaTreeProvider` | Lazy-loading introspection tree (Query/Mutation/Subscription roots) |
| Types | Webview | `TypesSearchProvider` | Search with kind filter, pagination, semantic search |
| Directives | TreeView | `DirectivesTreeProvider` | All directives with expandable arguments |

### Connection Management

```
~/.hugr/connections.json
  │
  ├── fs.watch()  →  ConnectionTreeProvider._load()
  │                    │
  │                    ├── onDidChangeTreeData  →  refresh tree
  │                    └── onDidChangeDefault   →  update all providers
  │
  └── ConnectionTreeProvider.createClient()
        │
        └── new HugrClient({ url, authType, apiKey, token })
```

When the default connection changes (user clicks "Set as Default" or the file changes externally), all providers receive a new `HugrClient` and reset their state.

### Schema Tree — Lazy Loading

The schema tree loads data on demand as nodes are expanded:

```
1. Roots loaded on setClient():
   __schema { queryType { name } mutationType { name } subscriptionType { name } }

2. When user expands a root (e.g., Query):
   __type(name: "Query") { fields { name type { ... } args { ... } } ... }

3. Field nodes with OBJECT/INTERFACE return types:
   returnTypeLoaded = false  →  loaded when expanded
   __type(name: "ReturnTypeName") { fields { ... } }

4. Arg nodes with INPUT_OBJECT/ENUM types:
   childrenLoaded = false  →  loaded when expanded
```

Each introspection query requests 4 levels of `ofType` nesting to correctly display wrapped types like `[Type!]!`.

### Types Search

The types search webview communicates with the extension host via `postMessage`:

```
Webview (HTML/JS)                    Extension Host (TypeScript)
  │                                    │
  │  { command: 'search', query }  →   │  _normalSearch() or _semanticSearchQuery()
  │                                    │    │
  │                                    │    ▼
  │                                    │  HugrClient.query(catalog query)
  │                                    │    │
  │                                    │    ▼  (Arrow IPC → JSON)
  │  { command: 'results', ... }   ←   │  postMessage(results)
  │                                    │
  │  { command: 'showType', name } →   │  showTypeDetail(name, client)
```

**Normal search** queries `core.catalog.types` with `ilike` filter and pagination.
**Semantic search** uses `_distance_to_query` ordering with automatic fallback to normal search if the server doesn't support embeddings.

### Detail Panel — Navigation

The detail panel is a single `WebviewPanel` that supports forward/back navigation:

```
Type A  →  click link  →  Type B  →  click link  →  Type C
                                                       │
                                                  click "← Back"
                                                       │
                                                       ▼
                                                    Type B
```

- `_history: string[]` stores visited type names (not panel titles)
- `_loadVersion` counter prevents stale async responses from overwriting current content
- Opening a directive detail resets the history stack

### Security

- **Content Security Policy**: `script-src` uses nonces; `style-src` allows `'unsafe-inline'` for dynamic badge colors
- **GraphQL injection**: All user input is escaped (backslashes and quotes) before string interpolation in queries
- **XSS prevention**: Server-returned `kind` values are validated against a known set before rendering SVGs via `innerHTML`; all text content is HTML-escaped

## Shared Configuration

Both extensions (and the kernel) share the same connection configuration file:

```json
// ~/.hugr/connections.json
{
  "default": "local",
  "connections": [
    {
      "name": "local",
      "url": "http://localhost:15004/ipc",
      "auth_type": "public"
    }
  ]
}
```

The VS Code extension watches this file with `fs.watch()` and reloads on external changes. The JupyterLab extension manages it through the `hugr_connection_service` server extension.

## Python Server Extension

```
hugr_connection_service/
  __init__.py                Package metadata
  handlers.py                HTTP handlers for connection CRUD
```

This is a Jupyter server extension that exposes REST endpoints for the JupyterLab extension to manage connections. It reads and writes `~/.hugr/connections.json`. The VS Code extension does not use this — it reads/writes the file directly.

## Build System

```
Makefile
  │
  ├── build-kernel    go build → .venv/bin/hugr-kernel
  ├── build-ext       cd extensions/jupyterlab && jlpm build
  ├── install         jupyter kernelspec install + copy perspective assets
  └── clean           remove build artifacts

extensions/vscode/
  └── npm run build   esbuild → out/extension.js (single bundle, ~490KB)

extensions/jupyterlab/
  └── jlpm build      TypeScript → lib/ + labextension/
```

## Dependencies

### Go (kernel)

| Dependency | Purpose |
|------------|---------|
| `go-zeromq/zmq4` | ZeroMQ sockets for Jupyter wire protocol |
| `google/uuid` | Session IDs |
| `hugr-lab/query-engine/client` | Hugr Go client (query execution) |
| `hugr-lab/query-engine/types` | Shared type definitions |
| `apache/arrow-go` | Arrow IPC streaming |
| `vektah/gqlparser/v2` | GraphQL parsing for IDE features |

### TypeScript (VS Code extension)

| Dependency | Purpose |
|------------|---------|
| `apache-arrow` | Arrow IPC decoding for multipart responses |
| `@types/vscode` | VS Code API types (dev) |
| `esbuild` | Bundler (dev) |

### TypeScript (JupyterLab extension)

| Dependency | Purpose |
|------------|---------|
| `apache-arrow` | Arrow IPC decoding |
| `@jupyterlab/application` | JupyterLab plugin API |
| `@lumino/widgets` | UI panels |
| `@codemirror/*` | Editor integration |
| `ag-grid-community` | Table rendering |
