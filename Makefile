KERNEL_DIR := $(HOME)/Library/Jupyter/kernels/hugr
DUCKDB_KERNEL_DIR := $(CURDIR)/../duckdb-kernel
EXT_DIR := $(CURDIR)/extensions/jupyterlab
VSCODE_DIR := $(CURDIR)/extensions/vscode
PYTHON := .venv/bin/python
VENV_LABEXT := $(CURDIR)/.venv/share/jupyter/labextensions

.PHONY: build install clean test \
	build-kernel build-ext build-vscode build-extensions \
	install-ext install-duckdb-extensions install-duckdb-extensions-dev install-jupyterlab

# --- Build ---

build: build-kernel build-ext

build-kernel:
	go build -o $(CURDIR)/.venv/bin/hugr-kernel ./cmd/hugr-kernel/

build-ext:
	cd $(EXT_DIR) && uv run jlpm install && uv run jlpm build

build-vscode:
	cd $(VSCODE_DIR) && npm install && npm run build

build-extensions: build-ext build-vscode

# --- Install ---

install: build-kernel install-ext install-duckdb-extensions
	mkdir -p $(KERNEL_DIR)
	@sed 's|"hugr-kernel"|"$(KERNEL_DIR)/hugr-kernel"|' kernel/kernel.json > $(KERNEL_DIR)/kernel.json
	@cp -f $(CURDIR)/.venv/bin/hugr-kernel $(KERNEL_DIR)/hugr-kernel
	@echo "Kernel installed to $(KERNEL_DIR)"

# graphql-ide (hugr-kernel's own JupyterLab extension)
install-ext: build-ext
	@mkdir -p $(VENV_LABEXT)/@hugr-lab
	@ln -sfn $(EXT_DIR)/hugr_graphql_ide/labextension $(VENV_LABEXT)/@hugr-lab/jupyterlab-graphql-ide
	@echo "Extension linked: jupyterlab-graphql-ide"

# perspective-viewer from PyPI (production: via uv sync from pyproject.toml dependency)
install-duckdb-extensions:
	uv sync
	@echo "Installed: hugr-perspective-viewer (from PyPI via uv sync)"

# perspective-viewer from local duckdb-kernel (dev: editable install for testing changes)
install-duckdb-extensions-dev:
	@if [ ! -d "$(DUCKDB_KERNEL_DIR)/extensions/jupyter/perspective-viewer" ]; then \
		echo "ERROR: duckdb-kernel not found at $(DUCKDB_KERNEL_DIR)"; \
		echo "Run: cd $(DUCKDB_KERNEL_DIR) && make build-jupyter"; \
		exit 1; \
	fi
	uv pip install -e $(DUCKDB_KERNEL_DIR)/extensions/jupyter/perspective-viewer/ --python $(PYTHON)
	@echo "Installed: hugr-perspective-viewer (editable from duckdb-kernel)"

# Full JupyterLab setup (build + install everything)
install-jupyterlab: build install-duckdb-extensions
	@echo "JupyterLab ready. Run: uv run jupyter lab"

# --- Test ---

test:
	uv run jupyter labextension list
	uv run jupyter server extension list
	@echo ""
	@echo "Expected extensions:"
	@echo "  labextensions: @hugr-lab/jupyterlab-graphql-ide, @hugr-lab/perspective-viewer"
	@echo "  server extensions: hugr_connection_service, hugr_perspective"
	@echo ""
	@echo "Run 'uv run jupyter lab' to test."

# --- Clean ---

clean:
	cd $(EXT_DIR) && rm -rf lib hugr_graphql_ide/labextension node_modules
	cd $(VSCODE_DIR) && rm -rf out node_modules
