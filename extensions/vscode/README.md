# Hugr GraphQL IDE for VS Code

Full-featured GraphQL IDE for [Hugr](https://hugr-lab.github.io/) in VS Code notebooks — query execution, schema exploration, autocompletion, and result visualization with Perspective viewer.

## Features

- **Connection Manager** — Add, edit, test, and manage multiple Hugr connections with support for public, API key, bearer token, and OIDC browser authentication
- **Schema Explorer** — Browse your Hugr schema with lazy-loading tree view, type details, and cross-reference navigation
- **Types Search** — Search and filter types across your schema with pagination
- **Directives List** — View all available directives with their arguments and descriptions
- **GraphQL Autocompletion** — Context-aware completions for fields, arguments, directives, and input types
- **Hover Information** — Hover over fields, types, arguments, and directives to see documentation with clickable links
- **Diagnostics** — Real-time validation of GraphQL queries with error highlighting
- **Result Rendering** — Visualize query results using Perspective viewer with interactive tables and charts
- **OIDC Login** — Browser-based authentication with automatic token refresh

## Screenshots

<!-- Screenshots will be added after initial release -->
<!-- See resources/screenshots/README.md for the list of required screenshots -->

## Installation

### Install the Kernel

The Hugr GraphQL kernel must be installed separately:

```bash
curl -fsSL https://raw.githubusercontent.com/hugr-lab/hugr-kernel/main/install.sh | bash
```

### Install this Extension

Search for **"Hugr GraphQL IDE"** in the VS Code Extensions panel, or install from the command line:

```bash
code --install-extension hugr-lab.hugr-graphql-ide
```

## Usage

1. Open or create a Jupyter notebook (`.ipynb`) in VS Code
2. Select the **Hugr GraphQL** kernel
3. Add a connection using the Hugr Explorer sidebar
4. Write and execute GraphQL queries

## Links

- [Hugr Kernel Repository](https://github.com/hugr-lab/hugr-kernel)
- [Hugr Documentation](https://hugr-lab.github.io/)
- [Report an Issue](https://github.com/hugr-lab/hugr-kernel/issues)

## License

MIT
