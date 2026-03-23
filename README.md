# Hugr GraphQL Kernel

A Jupyter kernel for executing [Hugr](https://hugr-lab.github.io/) GraphQL queries, built in Go. Includes IDE extensions for JupyterLab and VS Code with schema explorer, autocomplete, hover, diagnostics, and result visualization.

## Features

- **GraphQL query execution** via the Hugr Go client
- **Multiple connections** — manage named Hugr endpoints within a single session
- **Authentication** — public, API key, bearer token, and OIDC browser login
- **Session variables** — inject variables into GraphQL queries
- **Multipart results** — Arrow tables (Perspective viewer), JSON (tree viewer), errors
- **Streaming** — large datasets streamed via Apache Arrow IPC
- **Meta commands** — `:connect`, `:use`, `:auth`, `:status`, `:setvars`, and more
- **IDE features** — autocomplete, hover info, diagnostics, schema explorer, directives browser (JupyterLab & VS Code)

## Quick Start

### 1. Install the Kernel

```bash
curl -fsSL https://raw.githubusercontent.com/hugr-lab/hugr-kernel/main/install.sh | bash
```

Or install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/hugr-lab/hugr-kernel/main/install.sh | bash -s v0.1.0
```

### 2. Install the IDE Extension

**JupyterLab** — install the GraphQL IDE extension and the Perspective viewer:

```bash
pip install hugr-graphql-ide hugr-perspective-viewer
```

**VS Code** — install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=hugr-lab.hugr-graphql-ide):

```bash
code --install-extension hugr-lab.hugr-graphql-ide
```

You also need the [HUGR Result Viewer](https://marketplace.visualstudio.com/items?itemName=hugr-lab.hugr-result-renderer) extension for rendering query results in VS Code.

### 3. Connect and Query

In a Jupyter notebook or VS Code notebook, select the **Hugr GraphQL** kernel and run:

```graphql
{
  core {
    data_sources {
      name
      type
    }
  }
}
```

Or use meta commands to connect to a specific Hugr instance:

```
:connect myserver http://localhost:8080/ipc
```

## Meta Commands

| Command | Description |
|---------|-------------|
| `:connect <name> <url>` | Add a named connection |
| `:use <name>` | Set default connection |
| `:connections` | List all connections |
| `:auth <mode>` | Set auth mode (public, apikey, bearer, oidc) |
| `:key <api-key>` | Set API key for current connection |
| `:token <bearer-token>` | Set bearer token for current connection |
| `:setvars` | Set session variables (JSON on next lines) |
| `:showvars` | Show current session variables |
| `:clearvars` | Clear all session variables |
| `:json` | Output results as JSON instead of tables |
| `:status` | Show kernel status |
| `:whoami` | Show current connection and auth info |

## Development Setup

### Prerequisites

- Go 1.23+
- [uv](https://docs.astral.sh/uv/) — Python package manager
- Node.js 18+ (for extensions)

### Build and Install

```bash
git clone https://github.com/hugr-lab/hugr-kernel.git
cd hugr-kernel

# Build kernel and JupyterLab extension
make build

# Install kernel into Jupyter
make install

# Create Python environment with JupyterLab
uv sync
uv pip install hugr-perspective-viewer

# Launch JupyterLab
uv run jupyter lab
```

### Build Extensions

```bash
# Build both JupyterLab and VS Code extensions
make build-extensions

# Or build individually
make build-ext       # JupyterLab
make build-vscode    # VS Code
```

### VS Code Extension (from source)

```bash
cd extensions/vscode
npm install && npm run build
npx @vscode/vsce package --no-dependencies
code --install-extension hugr-graphql-ide-*.vsix
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed design documentation.

The kernel is a thin orchestration layer — it delegates query execution to the [Hugr Go client](https://github.com/hugr-lab/query-engine) and rendering to frontend extensions.

```
cmd/hugr-kernel/main.go           # Entry point, signal handling
internal/kernel/                   # ZMQ sockets, message protocol, handlers
internal/connection/               # Connection management, Hugr client wrapper
internal/session/                  # Session variables, execution counter
internal/meta/                     # Meta command parser and registry
internal/result/                   # Multipart response → viewer metadata
internal/completion/               # GraphQL autocomplete (AST-based)
internal/hover/                    # Hover information provider
internal/schema/                   # Schema introspection client with caching
extensions/jupyterlab/             # JupyterLab GraphQL IDE extension
extensions/vscode/                 # VS Code GraphQL IDE extension
hugr_connection_service/           # Jupyter server extension (connections, OIDC)
```

## CI/CD

- **CI**: Go build/vet/test + extension builds on every push and PR
- **Release**: Tag `v*` triggers cross-compilation for 4 platforms, publishes to PyPI and VS Code Marketplace, and creates a GitHub Release

## Related Projects

- [Hugr](https://github.com/hugr-lab/hugr) — core Hugr platform
- [Query Engine & Go Client](https://github.com/hugr-lab/query-engine) — Hugr query engine
- [DuckDB Kernel](https://github.com/hugr-lab/duckdb-kernel) — reference Go Jupyter kernel with Perspective viewer
- [Documentation](https://hugr-lab.github.io/) — Hugr docs

## License

[MIT](LICENSE)
