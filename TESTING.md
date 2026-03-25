# Release Testing Guide

Testing checklist for hugr-kernel releases on clean JupyterLab and VS Code environments.

## Prerequisites

- Hugr server running (e.g. `http://localhost:15004/ipc`)
- Connection configured in `~/.hugr/connections.json`:
  ```json
  {
    "connections": [
      {"name": "local", "url": "http://localhost:15004/ipc", "auth_type": "public"}
    ],
    "default": "local"
  }
  ```
- A test query that returns geometry (e.g. points, polygons)

---

## JupyterLab (clean install)

### 1. Install

```bash
# Install kernel binary + extensions
curl -fsSL https://raw.githubusercontent.com/hugr-lab/hugr-kernel/main/install.sh | bash

# Or from specific version
curl -fsSL https://raw.githubusercontent.com/hugr-lab/hugr-kernel/main/install.sh | bash -s v0.1.0
```

### 2. Verify installation

```bash
jupyter kernelspec list
# Expected: hugr  /path/to/kernels/hugr

jupyter labextension list
# Expected:
#   @hugr-lab/perspective-viewer  enabled OK
#   @hugr-lab/jupyterlab-graphql-ide  enabled OK (only if hugr-graphql-ide published)

jupyter server extension list
# Expected:
#   hugr_perspective  enabled OK    (spool proxy for Arrow streaming)
#   hugr_connection_service  enabled OK  (only if hugr-graphql-ide installed)
```

### 3. Start JupyterLab

```bash
jupyter lab
```

### 4. Functional tests

#### 4.1 Kernel starts
- [ ] Create new notebook, select "Hugr GraphQL" kernel
- [ ] Kernel indicator shows connected (green circle)

#### 4.2 Basic query
- [ ] Execute: `{ function { core { info { version } } } }`
- [ ] Result displays as JSON in output cell

#### 4.3 Table result
- [ ] Execute a query that returns tabular data (Arrow)
- [ ] Perspective table viewer appears with columns
- [ ] Columns are sortable, filterable
- [ ] Row count shown in metadata

#### 4.4 Geometry / Map
- [ ] Execute a query with geometry column (WKB/GeoArrow)
- [ ] Click "Map" tab in the viewer
- [ ] Points/polygons render on the map
- [ ] Only **one** network request to `/hugr/spool/arrow/stream` with `geoarrow=1` (check DevTools Network tab)
- [ ] Table tab still shows `{geometry}` placeholder in geometry column

#### 4.5 Multipart results
- [ ] Execute a query with multiple result parts (e.g. nested GraphQL returning several tables)
- [ ] Each part appears as a separate tab

#### 4.6 Connection manager (requires hugr-graphql-ide)
- [ ] Connections sidebar shows configured connections
- [ ] Can add/edit/remove/test connections
- [ ] Can switch default connection

#### 4.7 Schema explorer (requires hugr-graphql-ide)
- [ ] Schema tree loads lazily
- [ ] Types and fields are browsable

---

## VS Code (clean install)

### 1. Install kernel

```bash
curl -fsSL https://raw.githubusercontent.com/hugr-lab/hugr-kernel/main/install.sh | bash
```

### 2. Install VS Code extension

From Marketplace:
```bash
code --install-extension hugr-lab.hugr-graphql-ide
```

Or from VSIX (download from GitHub release):
```bash
code --install-extension hugr-graphql-ide.vsix
```

### 3. Verify installation

```bash
jupyter kernelspec list
# Expected: hugr  /path/to/kernels/hugr

code --list-extensions | grep hugr
# Expected: hugr-lab.hugr-graphql-ide
```

### 4. Functional tests

#### 4.1 Kernel starts
- [ ] Open a `.ipynb` file or create new Jupyter notebook in VS Code
- [ ] Select "Hugr GraphQL" kernel
- [ ] Kernel connects successfully

#### 4.2 Basic query
- [ ] Execute: `{ function { core { info { version } } } }`
- [ ] Result renders in output cell

#### 4.3 Table result
- [ ] Execute a query returning tabular data
- [ ] Perspective viewer renders in the output cell
- [ ] Table is interactive (sort, filter)

#### 4.4 Geometry / Map
- [ ] Execute a query with geometry column
- [ ] Click "Map" tab
- [ ] Geometry renders on the map
- [ ] Check: Arrow streaming works via kernel's built-in HTTP server (not spool proxy)

#### 4.5 Connection manager
- [ ] "Hugr Connections" tree view appears in sidebar
- [ ] Can add/remove/test connections
- [ ] Connection status indicators work

#### 4.6 Schema explorer
- [ ] "Hugr Schema" tree view loads
- [ ] Types and fields expandable

---

## Quick smoke test (both platforms)

Minimal test to confirm the release is not broken:

```graphql
{ function { core { info { version } } } }
```

Expected: JSON result with version string. If this works, kernel binary, connection, and result rendering pipeline are functional.

For geometry specifically:

```graphql
# Replace with a query that returns geometry in your Hugr instance
{ query { places { name geom } } }
```

Expected: Table with `{geometry}` placeholder in geom column, Map tab shows points/polygons.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Kernel not in kernel list | Binary not installed | Re-run `install.sh` |
| "No module named hugr_perspective" | Extension not installed | `pip install hugr-perspective-viewer` |
| Map shows empty | Old kernel binary (WKB not converted) | Restart kernel, re-execute query |
| Two requests to spool proxy on map open | Expected fallback behavior | N/A (see known issues) |
| Perspective viewer not rendering | Missing labextension | Check `jupyter labextension list` |
| "Connection refused" in results | Hugr server not running | Start Hugr server |
| VS Code: plain text output only | Missing perspective static files | Re-run `install.sh` to download `perspective-static.tar.gz` |

---

## Dev environment testing

For developers working on hugr-kernel:

```bash
# Clone and setup
git clone https://github.com/hugr-lab/hugr-kernel.git
cd hugr-kernel
uv sync

# Build and install (uses PyPI for perspective-viewer)
make install

# Or with local duckdb-kernel changes
make install-duckdb-extensions-dev

# Verify
make test

# Run JupyterLab
uv run jupyter lab
```
