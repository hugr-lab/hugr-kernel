# Hugr IDE Layer Specification

Repository:
https://github.com/hugr-lab/duckdb-kernel

Status:
Planned

Supported Frontends:

- JupyterLab
- VS Code

Goal:
Provide a GraphQL IDE experience comparable to GraphiQL inside both Jupyter and VS Code, including editor UX, completion, validation, formatting, and schema exploration.

---

# 1. Scope

This specification covers three major capabilities:

1. GraphQL Editor UX
2. Completion / Validation / Inspect
3. Explorer

The implementation is split into:

- backend behavior (kernel side)
- frontend behavior (JupyterLab and VS Code extensions)

---

# 2. UX Goal

The target user experience must be similar to GraphiQL:

- syntax highlighting
- automatic closing brackets
- indentation
- formatting
- code completion
- hover documentation
- diagnostics / inline error highlighting
- directive completion
- argument completion
- selection set guidance
- schema explorer
- logical Hugr explorer

This experience must be available in both:

- JupyterLab
- VS Code

---

# 3. Architecture Overview

The IDE layer is split into two cooperating parts.

## 3.1 Backend (Kernel Side)

The backend provides:

- cursor-context analysis
- completion results
- hover / inspect data
- diagnostics
- explorer APIs
- lazy schema access
- schema and explorer query caching

The backend must not preload the full GraphQL schema.

## 3.2 Frontend (Extension Side)

The frontend provides:

- editor integration
- syntax highlighting
- bracket pairing
- formatting integration
- completion UI
- diagnostics rendering
- explorer UI
- modal detail windows

This must be implemented for both:

- JupyterLab extension
- VS Code extension

---

# 4. Backend Specification

## 4.1 Core Responsibilities

The backend must:

- tokenize editor text using gqlparser lexer
- resolve cursor context
- translate context into schema projection requests
- call Hugr schema APIs
- return completion items
- return inspect information
- return diagnostics
- return explorer tree nodes
- return detailed modal data for entities

The backend uses:

- Go
- gqlparser lexer and AST types
- Hugr Go client

---

## 4.2 Cursor Context Resolution

Completion and diagnostics are based on cursor context derived from the token stream.

The backend must identify contexts such as:

- root field completion
- nested field completion
- argument completion
- argument value completion
- input object field completion
- directive completion
- directive argument completion
- variable completion

The completion path must not depend on full-document parsing.

---

## 4.3 Completion Search Modes

The backend must support schema search using one or more of the following strategies:

- prefix
- fuzzy / ilike
- regexp
- semantic similarity (optional)

The default search strategy should prefer deterministic results:

1. prefix
2. fuzzy
3. regexp
4. semantic fallback

---

## 4.4 Result Limits

Completion responses must be small.

Recommended limits:

- default: 20 items
- maximum: 50 items

The backend must avoid returning large payloads for completion items.

Completion items should include:

- label
- kind
- detail
- short documentation
- insert text / snippet

Full descriptions should be loaded through inspect / hover.

---

## 4.5 Inspect / Hover

The backend must support hover information for:

- types
- fields
- arguments
- directives
- tables
- views
- functions
- modules
- sources

Hover content may include:

- description
- return type
- arguments
- deprecation information
- related object information

---

## 4.6 Diagnostics

The backend must return diagnostics for invalid queries.

Validation includes:

- unknown field
- unknown argument
- missing required argument
- missing selection set
- invalid directive location
- duplicate non-repeatable directive

Diagnostics must include ranges so the frontend can highlight errors inline.

---

## 4.7 Lazy GraphQL Schema Access

The backend must not load the entire schema eagerly.

Instead it must use lazy schema projection requests.

Examples of projections:

- root fields
- fields for a specific parent type
- arguments for a field
- input fields for an input type
- directives for a specific location
- directive arguments
- type lookup by name
- type lookup by description

The backend may cache small projection results temporarily.

---

## 4.8 Explorer APIs

The backend must expose explorer-oriented methods.

Two explorer families are required:

### A. GraphQL Schema Explorer

Supports:

- types
- fields
- arguments
- directives
- enum values
- input objects
- interfaces
- unions

Supports search by:

- name
- description

### B. Hugr Logical Schema Explorer

Supports:

- data sources
- modules
- submodules
- functions
- tables
- views

Important rule:

A module and a submodule may contain any combination of:

- functions
- tables
- views

This must be reflected in the tree structure.

---

## 4.9 Detailed Entity APIs

The backend must provide detailed views for opening modal windows in the frontend.

Detailed entity views are required for:

- GraphQL type
- GraphQL field
- GraphQL directive
- module
- submodule
- function
- table
- view
- data source

### Table details must include:

- description
- query paths
- mutations
- columns
- related objects
- linked entities

### View details must include:

- description
- query paths
- columns
- related objects

### Function details must include:

- signature
- description
- return information
- related objects

### Module / Submodule details must include:

- description
- contained submodules
- contained functions
- contained tables
- contained views

### Data source details must include:

- source metadata
- exposed modules
- related objects

---

# 5. Frontend Specification

Support is required in both:

- JupyterLab
- VS Code

The UX must be consistent across both frontends.

---

## 5.1 GraphQL Editor UX

The frontend must provide:

- GraphQL syntax highlighting
- automatic insertion of closing brackets:
  - ()
  - {}
  - []
  - quotes
- indentation rules
- format document
- format selection
- diagnostics rendering
- hover tooltips
- completion UI
- snippet insertion

---

## 5.2 Formatting

Formatting is performed on the frontend side.

Recommended formatter:

- Prettier with GraphQL parser

The frontend triggers formatting and applies the formatted code back into the cell editor.

---

## 5.3 Completion UI

The frontend must:

- debounce completion requests
- cancel outdated requests
- render completion lists
- render documentation previews
- apply snippets when provided

Completion must feel interactive and low-latency.

---

## 5.4 Diagnostics Rendering

The frontend must render diagnostics directly in the editor:

- underlines
- severity markers
- inline messages or hover messages

This must work in both JupyterLab and VS Code.

---

## 5.5 Hover

When the user hovers over a field, argument, directive, type, table, view, function, module, or source, the frontend must request detail data and render a hover popup.

---

## 5.6 Explorer UI

The frontend must provide two explorers.

### A. GraphQL Schema Explorer

Displays:

- types
- directives
- fields
- arguments
- input objects
- enums
- interfaces
- unions

Supports:

- lazy loading
- search by name
- search by description

### B. Hugr Logical Explorer

Displays:

- data sources
- modules
- submodules
- functions
- tables
- views

Important rule:

Modules and submodules are heterogeneous containers.
Each module or submodule may contain:

- functions
- tables
- views
- additional submodules

This must be represented in the frontend tree.

---

## 5.7 Detail Modals

The frontend must provide modal windows for:

- GraphQL types
- GraphQL fields
- GraphQL directives
- modules
- submodules
- functions
- tables
- views
- data sources

These modals must show detailed metadata fetched from the backend.

For tables, the modal must explicitly show both:

- queries
- mutations

---

# 6. Search Requirements

## 6.1 GraphQL Search

The system must support searching GraphQL schema entities by:

- exact name
- prefix
- description text
- fuzzy match
- regexp
- optional semantic similarity

## 6.2 Logical Explorer Search

The system must support searching logical Hugr entities such as:

- modules
- submodules
- functions
- tables
- views
- sources

---

# 7. Performance Requirements

The system must support very large schemas.

Assumptions:

- millions of fields are possible
- schema size may vary by role
- schema may change over time

Performance strategy:

- lazy loading
- small projection responses
- search on backend
- frontend debouncing
- cancellation of outdated requests
- short-lived caching of projections

---

# 8. Caching Requirements

The backend may cache:

- projection results
- inspect results
- explorer nodes
- detail modal data

Cache keys must include connection context.

Caches must be invalidated when connection or authorization context changes.

---

# 9. Compatibility Requirements

All functionality described here must be supported in both:

- JupyterLab
- VS Code

Differences in UI implementation are acceptable, but the capability set must remain equivalent.

---

# 10. Definition of Done

This specification is complete when:

- editor UX is GraphQL-aware in both JupyterLab and VS Code
- completion works for fields, arguments, directives, and variables
- diagnostics highlight invalid query nodes inline
- formatting works
- GraphQL Schema Explorer works with lazy introspection
- logical Hugr explorer works
- modules and submodules can each display functions, tables, views, and submodules
- searching by name and description works
- modal detail views work
- table detail views include both queries and mutations
- data sources are visible in the explorer
