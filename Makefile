KERNEL_DIR := $(HOME)/Library/Jupyter/kernels/hugr
DUCKDB_KERNEL_DIR := $(CURDIR)/../duckdb-kernel
EXT_DIR := $(CURDIR)/extensions/jupyterlab
VENV_LABEXT := $(CURDIR)/.venv/share/jupyter/labextensions

.PHONY: build install clean test copy-perspective build-ext install-ext build-kernel

build: build-kernel build-ext

build-kernel:
	go build -o $(CURDIR)/.venv/bin/hugr-kernel ./cmd/hugr-kernel/

build-ext:
	cd $(EXT_DIR) && uv run jlpm install && uv run jlpm build

install: install-ext copy-perspective
	mkdir -p $(KERNEL_DIR)
	@sed 's|"hugr-kernel"|"$(KERNEL_DIR)/hugr-kernel"|' kernel/kernel.json > $(KERNEL_DIR)/kernel.json
	@ln -sfn $(CURDIR)/.venv/bin/hugr-kernel $(KERNEL_DIR)/hugr-kernel
	@ln -sfn $(CURDIR)/.venv/bin/static $(KERNEL_DIR)/static
	@echo "Kernel installed to $(KERNEL_DIR)"

install-ext: build-ext
	@mkdir -p $(VENV_LABEXT)/@hugr-lab
	@ln -sfn $(EXT_DIR)/hugr_graphql_ide/labextension $(VENV_LABEXT)/@hugr-lab/jupyterlab-graphql-ide
	@echo "Extension linked to $(VENV_LABEXT)/@hugr-lab/jupyterlab-graphql-ide"

copy-perspective:
	@if [ -d "$(DUCKDB_KERNEL_DIR)/extensions/jupyterlab/hugr_perspective/labextension" ]; then \
		mkdir -p $(VENV_LABEXT)/@hugr-lab; \
		ln -sfn $(DUCKDB_KERNEL_DIR)/extensions/jupyterlab/hugr_perspective/labextension $(VENV_LABEXT)/@hugr-lab/perspective-viewer; \
		echo "Perspective viewer extension linked"; \
	else \
		echo "Perspective viewer not found (build duckdb-kernel extension first)"; \
	fi

test:
	uv run jupyter labextension list
	uv run jupyter server extension list
	@echo "Run 'uv run jupyter lab' to test."

clean:
	cd $(EXT_DIR) && rm -rf lib hugr_graphql_ide/labextension node_modules
