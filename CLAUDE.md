# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Hugr GraphQL Jupyter Kernel — a Go-based Jupyter kernel for executing Hugr GraphQL queries in JupyterLab, JupyterHub, and VS Code Notebooks.

- **Language**: Go 1.26.1
- **License**: MIT
- **Go workspace**: Part of `~/projects/hugr-lab/go.work`

## Build & Development

```bash
make build        # build the kernel binary
make install      # install kernel spec into Jupyter + copy Perspective assets
make test         # verify kernel installation
uv sync           # create isolated Python environment with JupyterLab
uv run jupyter lab  # launch JupyterLab for testing
go build ./...    # build all packages
go vet ./...      # run vet
go test ./...     # run all tests
```

## Architecture

The kernel is a **thin orchestration layer** — it does NOT duplicate logic from the Hugr Go client.

```
cmd/hugr-kernel/main.go          # Entry point, signal handling, env config
internal/kernel/
  kernel.go                      # ZMQ sockets, message loops, heartbeat
  message.go                     # Jupyter wire protocol v5.0
  handlers.go                    # Shell message handlers, execute_request flow
  arrowhttp.go                   # Arrow IPC HTTP streaming server
internal/connection/
  connection.go                  # Connection struct, Hugr client wrapper
  manager.go                     # ConnectionManager (add/remove/default)
internal/session/session.go      # Session variables, execution counter
internal/meta/
  parser.go                      # Meta command parser (: prefix detection)
  registry.go                    # Command registry and dispatch
  commands.go                    # All 14 meta command implementations
internal/result/
  handler.go                     # Multipart response → viewer metadata
  spool.go                       # Arrow IPC file spool (temp files)
internal/renderer/table.go       # ASCII table fallback
```

**Result MIME type**: `application/vnd.hugr.result+json` with `parts` array for multipart results.

## Constitutional Constraints

1. **Thin kernel** — orchestration only, no Hugr client logic duplication
2. **Streaming first** — Arrow IPC streaming, never load full datasets into memory
3. **No UI in kernel** — only emit viewer metadata; rendering is frontend responsibility
4. **No eager schema loading** — lazy loading in Phase 2
5. **No secret persistence** — credentials stay in session memory only
6. **Reuse patterns** from DuckDB kernel and Hugr Go client

## Ecosystem

| Component | Local Path |
|-----------|------------|
| Hugr (core) | ~/projects/hugr-lab/hugr/ |
| Query Engine & Go Client | ~/projects/hugr-lab/query-engine/ |
| DuckDB Kernel (reference) | ~/projects/hugr-lab/duckdb-kernel/ |
| Docs Site | ~/projects/hugr-lab/hugr-lab.github.io/ |

## Active Technologies
- TypeScript 5.x (JupyterLab extension), Python 3.11 (server extension), Go 1.26.1 (kernel — minimal changes) + `@jupyterlab/application`, `@lumino/widgets`, webpack 5, tornado (server proxy) (006-hugr-explorer)
- `~/.hugr/connections.json` (existing, no changes) (006-hugr-explorer)
- TypeScript 5.8, bundled with esbuild (existing pipeline) + `@types/vscode` ^1.80.0 (existing), no new npm dependencies — use native VS Code APIs (TreeView, WebviewPanel, ThemeIcon) (007-vscode-hugr-explorer)
- Go 1.26.1 (kernel), Python 3.11 (connection service), TypeScript 5.x (JupyterLab extension) tornado (existing), `hugr.client` (existing), `@jupyterlab/application` (existing), `authlib` (new — OIDC/PKCE for Python) (008-oidc-browser-login)
- `~/.hugr/connections.json` (existing file, extended with `tokens` field) (008-oidc-browser-login)
- Go 1.26.1 (kernel), TypeScript 5.8 (extensions), Python 3.11 (server extension) + GitHub Actions, hatchling + hatch-jupyter-builder (PyPI), @vscode/vsce (Marketplace) (009-publish-distribution)
- N/A (CI/CD pipeline, no data storage) (009-publish-distribution)
- Go 1.26.1 (kernel), Python 3.11 (connection service, hugr-client), TypeScript 5.x (JupyterLab + VS Code extensions) + `net/http` (Go), `requests` + `websockets` (Python hugr-client), `httpx` (Python OIDC/hub), `tornado` (Python proxy), Node.js `https` (VS Code) (010-tls-skip-verify)
- `~/.hugr/connections.json` (shared config file) (010-tls-skip-verify)

## Recent Changes
- 006-hugr-explorer: Added TypeScript 5.x (JupyterLab extension), Python 3.11 (server extension), Go 1.26.1 (kernel — minimal changes) + `@jupyterlab/application`, `@lumino/widgets`, webpack 5, tornado (server proxy)
