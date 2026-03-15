# Hugr GraphQL Kernel

A Jupyter kernel for executing [Hugr](https://github.com/hugr-lab/hugr) GraphQL queries, built in Go.

## Overview

Hugr Kernel provides a Jupyter-compatible execution environment for Hugr GraphQL queries. It integrates Hugr with analytical notebook workflows across JupyterLab, JupyterHub, and VS Code Notebooks.

### Features

- **GraphQL query execution** via the Hugr Go client
- **Multiple connections** — manage named Hugr endpoints within a single session
- **Authentication** — public, API key, bearer token, and OIDC browser flows
- **Session variables** — inject variables into GraphQL execution
- **Multipart results** — Arrow tables (Perspective viewer), JSON (tree viewer), errors, extensions
- **Streaming** — large datasets streamed via Apache Arrow IPC, no full materialization
- **Meta commands** — `:connect`, `:use`, `:auth`, `:status`, `:whoami`, `:setvars`, and more

### Architecture

The kernel is a thin orchestration layer — it delegates query execution to the [Hugr Go client](https://github.com/hugr-lab/query-engine) and rendering to frontend extensions. It does not contain UI logic; it only emits viewer metadata.

```
Jupyter Cell → Meta Command Parser → Connection Resolver →
Session Variable Injection → Hugr Go Client → Multipart Response →
Part Materialization → Viewer Metadata → Frontend Rendering
```

## Status

Under development. See [HUGR_KERNEL_SPEC.md](HUGR_KERNEL_SPEC.md) for the full specification.

## Related Projects

- [Hugr](https://github.com/hugr-lab/hugr) — core Hugr platform
- [Query Engine & Go Client](https://github.com/hugr-lab/query-engine) — Hugr query engine
- [Python Client](https://github.com/hugr-lab/hugr-client) — Hugr Python client
- [DuckDB Kernel](https://github.com/hugr-lab/duckdb-kernel) — reference Go Jupyter kernel with Perspective viewer
- [Documentation](https://hugr-lab.github.io/) — Hugr documentation

## License

[MIT](LICENSE)
