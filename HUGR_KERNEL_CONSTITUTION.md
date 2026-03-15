
# Hugr GraphQL Kernel
## Constitution

This document defines the architectural principles guiding the Hugr GraphQL Jupyter Kernel.

---

# 1. Kernel Simplicity

The kernel must remain a **thin orchestration layer**.

Responsibilities:

- connection management
- authentication
- session variables
- query execution routing
- viewer metadata generation

The kernel must **not duplicate logic already implemented in Hugr clients**.

---

# 2. Streaming First

The system must support **streaming data processing**.

Large datasets must be streamed using Arrow.

The kernel must avoid loading full datasets into memory whenever possible.

---

# 3. Multipart Result Support

Hugr queries may return multiple result parts.

The kernel must support:

- JSON objects
- Arrow tables
- errors
- extensions

The rendering system must support **multiple simultaneous viewers**.

---

# 4. Viewer Decoupling

The kernel must not contain UI logic.

Rendering must be delegated to:

- JupyterLab extensions
- VS Code extensions

The kernel only emits **viewer metadata**.

---

# 5. Language Choice

The kernel is implemented in **Go 1.26.1**.

Reasons:

- Hugr ecosystem compatibility
- static binary distribution
- high-performance streaming
- simple concurrency model

---

# 6. Compatibility

The kernel must remain compatible with:

- Jupyter protocol
- JupyterLab
- JupyterHub
- VS Code notebooks

---

# 7. Schema Scalability

Hugr schemas may be very large.

The kernel must implement:

- lazy schema loading
- incremental schema introspection
- caching

Full schema downloads are prohibited.

---

# 8. Security Model

Authentication must support:

- public access
- API keys
- bearer tokens
- OIDC browser flows

The kernel must never persist secrets outside user scope.

---

# 9. Extensibility

Future capabilities must be supported without breaking architecture:

- interactive input widgets
- Hugr application generation
- agent integrations
- MCP tool integration

---

# 10. Reusability

The Hugr kernel must reuse architectural patterns from:

- DuckDB kernel
- Hugr Go client
- existing Perspective viewer infrastructure

Avoid duplicating working systems.

---

# 11. Performance

The kernel must prioritize:

- minimal memory usage
- streaming Arrow results
- avoiding unnecessary JSON transformations

---

# 12. Observability

The kernel must provide:

- status inspection
- connection inspection
- authentication status

Example commands:

:status
:connections
:whoami
