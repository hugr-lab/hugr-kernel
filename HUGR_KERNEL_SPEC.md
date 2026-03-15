
# Hugr GraphQL Jupyter Kernel
## Specification (SpecKit)

Repository: https://github.com/hugr-lab/hugr-kernel  
Language: Go  
Go Version: **1.26.1**  
License: MIT  

---

# 1. Purpose

The Hugr GraphQL Kernel provides a **Jupyter-compatible execution environment** for Hugr GraphQL queries.

It allows users to run Hugr queries directly from:

- JupyterLab
- JupyterHub
- VS Code Notebooks

The kernel integrates Hugr with analytical notebook workflows and the Hugr analytical workspace environment.

---

# 2. Core Goals

The kernel must provide:

- GraphQL query execution
- Hugr connection management
- session-level variables
- result rendering for Hugr multipart responses
- authentication support
- compatibility with Jupyter protocol
- compatibility with VS Code notebooks

Future phases add:

- schema-aware autocomplete
- lazy schema loading
- schema caching

---

# 3. Implementation

Language: **Go**

Required version:

Go **1.26.1**

Reasons:

- Hugr ecosystem already uses Go
- existing Hugr Go client
- simple static binary distribution
- efficient streaming support
- simple Jupyter kernel integration via stdio

---

# 4. Dependencies

Primary dependency:

- Hugr Go Client

Responsibilities of the Hugr client:

- execute GraphQL queries
- parse multipart responses
- stream Arrow parts
- decode JSON parts
- attach authentication headers

The kernel orchestrates execution but does not implement GraphQL transport itself.

---

# 5. High-Level Architecture

Jupyter Cell
↓
Meta Command Parser
↓
Connection Resolver
↓
Session Variable Injection
↓
Hugr Go Client
↓
Multipart Hugr Response
↓
Part Materialization
↓
Viewer Metadata
↓
Frontend Rendering

---

# 6. Connection Model

A session may contain multiple Hugr connections.

Each connection contains:

- name
- endpoint URL
- authentication mode
- credentials / token state

Example:

connections:
  dev
  prod

default:
  dev

The **first connection becomes default automatically**.

---

# 7. Connection Configuration

Connections can be defined in two ways.

## Kernel configuration

Connections may be provided in kernel configuration or environment variables.

Used in:

- JupyterHub
- managed environments

## Runtime meta commands

Example:

:connect dev https://dev.example.com/graphql

Authentication configuration:

:auth apikey
:key XXXXX

or

:auth bearer
:token eyJ...

or

:auth oidc
:login dev

---

# 8. Connection Selection

The kernel maintains a **default connection**.

### Change default

:use prod

### Per-query connection

:use dev
query {
  orders {
    id
  }
}

This does not change the session default permanently unless explicitly set.

---

# 9. Authentication Modes

Supported modes:

- public
- API key
- bearer token
- OIDC browser flow

### OIDC Flow

1. user runs `:login <connection>`
2. browser opens
3. user authenticates
4. kernel receives authorization code
5. kernel exchanges code for tokens
6. tokens stored in session
7. automatic refresh when required

---

# 10. Session Variables

Variables exist at session scope.

Commands:

:setvars
{
  "date": "2026-03-01",
  "region": "EU"
}

:showvars
:clearvars

Variables are injected into GraphQL execution.

---

# 11. Query Execution

The cell body contains a GraphQL query.

Example:

query {
  sales {
    id
    total
  }
}

Variables are taken from session state.

---

# 12. Hugr Result Model

Hugr may return multiple **result parts**.

Supported types:

- JSON parts
- Arrow parts
- Errors
- Extensions

---

# 13. Result Rendering

Rendering rules:

JSON parts → tree viewer

Arrow parts → Perspective table viewer

Errors → error panel

Extensions → JSON viewer

A single query may render **multiple parts simultaneously**.

---

# 14. Result Metadata Contract

Each part contains:

- part_id
- part_type
- title
- artifact location or inline payload

Arrow parts may reference Arrow files.

JSON parts may be inline.

---

# 15. Phase 2 — Schema Completion

Future capabilities:

- GraphQL autocomplete
- lazy schema loading
- schema fragment loading
- schema caching
- hover inspection

The kernel **must not load the full schema eagerly**.

---

# 16. Meta Commands

:connections
:connect <name> <url>
:auth <mode>
:key <value>
:token <value>
:login <connection>
:logout <connection>
:use <connection>
:status
:whoami
:setvars
:showvars
:clearvars

---

# 17. Definition of Done

Phase 1 complete when:

- kernel launches in JupyterLab
- kernel launches in VS Code
- GraphQL execution works
- multiple connections supported
- default connection works
- :use works
- authentication works
- OIDC browser flow works
- session variables work
- multipart Hugr responses render correctly
- Arrow parts render via Perspective
- JSON parts render as trees

Phase 2 complete when:

- autocomplete works
- schema lazy loading works
- schema caching works
