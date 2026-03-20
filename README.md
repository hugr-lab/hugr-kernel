# Hugr GraphQL Kernel

A Jupyter kernel for executing [Hugr](https://github.com/hugr-lab/hugr) GraphQL queries, built in Go. Includes IDE extensions for JupyterLab and VS Code with schema explorer, autocomplete, hover, and diagnostics.

## Features

- **GraphQL query execution** via the Hugr Go client
- **Multiple connections** — manage named Hugr endpoints within a single session
- **Authentication** — public, API key, bearer token, and OIDC
- **Session variables** — inject variables into GraphQL queries
- **Multipart results** — Arrow tables (Perspective viewer), JSON (tree viewer), errors
- **Streaming** — large datasets streamed via Apache Arrow IPC
- **Meta commands** — `:connect`, `:use`, `:auth`, `:status`, `:setvars`, and more
- **IDE features** — autocomplete, hover info, diagnostics, schema explorer (JupyterLab & VS Code)

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/hugr-lab/hugr-kernel/main/install.sh | bash
```

Or install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/hugr-lab/hugr-kernel/main/install.sh | bash -s v0.1.0
```

## Development Setup

### Prerequisites

- Go 1.23+
- [uv](https://docs.astral.sh/uv/) — Python package manager
- Node.js 18+ (for VS Code extension)

### Build and install

```bash
# Clone the repository
git clone https://github.com/hugr-lab/hugr-kernel.git
cd hugr-kernel

# Build and install kernel into Jupyter
make build
make install

# Create Python environment with JupyterLab and the result viewer extension
uv sync
uv pip install hugr-perspective-viewer

# Launch JupyterLab
uv run jupyter lab
```

### VS Code Extension

The Hugr GraphQL IDE extension for VS Code provides a schema explorer, types search, directives browser, and type detail panels.

```bash
cd extensions/vscode
npm install && npm run build

# Package and install
npx @vscode/vsce package --no-dependencies
code --install-extension hugr-graphql-ide-*.vsix
```

You also need the [HUGR Result Viewer](https://marketplace.visualstudio.com/items?itemName=hugr-lab.hugr-result-renderer) extension for rendering query results.

### Overriding the JupyterLab extension from source

If you are developing the [Perspective viewer extension](https://github.com/hugr-lab/duckdb-kernel/tree/main/extensions/jupyterlab) and want to use a local build instead of the PyPI version:

```bash
# Build the extension from duckdb-kernel source
cd ../duckdb-kernel/extensions/jupyterlab
jlpm install && jlpm build:prod

# Back in hugr-kernel, overwrite the installed extension
cd ../../hugr-kernel
EXT_DIR=$(find .venv -path "*/labextensions/@hugr-lab/perspective-viewer" -type d)
rm -rf "$EXT_DIR/static"
cp -r ../duckdb-kernel/extensions/jupyterlab/hugr_perspective/labextension/static "$EXT_DIR/static"
cp ../duckdb-kernel/extensions/jupyterlab/hugr_perspective/labextension/package.json "$EXT_DIR/package.json"
```

## Usage

### Connecting to a Hugr instance

```
:connect local http://localhost:8080/graphql
```

### Running queries

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

### Meta commands

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

### Per-query connection override

```
:use remote
{
  core { data_sources { name } }
}
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed description of the project structure, data flows, and extension architecture.

The kernel is a thin orchestration layer — it delegates query execution to the [Hugr Go client](https://github.com/hugr-lab/query-engine) and rendering to frontend extensions.

```
cmd/hugr-kernel/main.go           # Entry point, signal handling
internal/kernel/                   # ZMQ sockets, message protocol, handlers
internal/connection/               # Connection management, Hugr client wrapper
internal/session/                  # Session variables, execution counter
internal/meta/                     # Meta command parser and registry
internal/result/                   # Multipart response → viewer metadata
internal/renderer/                 # ASCII table fallback
internal/completion/               # GraphQL autocomplete (AST-based)
internal/hover/                    # Hover information provider
internal/schema/                   # Schema introspection client with caching
extensions/jupyterlab/             # JupyterLab GraphQL IDE extension
extensions/vscode/                 # VS Code GraphQL IDE extension
hugr_connection_service/           # Jupyter server extension for connection management
```

## CI/CD

- **CI**: build, vet, test on every push and PR
- **Release**: tag `v*` triggers cross-compilation for linux/amd64, linux/arm64, darwin/arm64, windows/amd64 and creates a GitHub Release

## Related Projects

- [Hugr](https://github.com/hugr-lab/hugr) — core Hugr platform
- [Query Engine & Go Client](https://github.com/hugr-lab/query-engine) — Hugr query engine
- [DuckDB Kernel](https://github.com/hugr-lab/duckdb-kernel) — reference Go Jupyter kernel with Perspective viewer
- [Documentation](https://hugr-lab.github.io/) — Hugr docs

## License

[MIT](LICENSE)
