BINARY := hugr-kernel
KERNEL_DIR := $(HOME)/Library/Jupyter/kernels/hugr

.PHONY: build install clean test copy-perspective build-extensions

build:
	go build -o $(BINARY) ./cmd/hugr-kernel

install: build copy-perspective
	mkdir -p $(KERNEL_DIR)
	ln -sf $(CURDIR)/$(BINARY) $(KERNEL_DIR)/$(BINARY)
	cp kernel/kernel.json $(KERNEL_DIR)/kernel.json
	@# Update kernel.json to use absolute path
	@sed -i'' -e 's|"hugr-kernel"|"$(KERNEL_DIR)/$(BINARY)"|' $(KERNEL_DIR)/kernel.json
	@# Copy kernel logos
	@cp kernel/logo-32x32.png kernel/logo-64x64.png $(KERNEL_DIR)/ 2>/dev/null || true
	@# Symlink perspective static files next to binary
	@ln -sfn $(CURDIR)/static $(KERNEL_DIR)/static
	@echo "Kernel installed to $(KERNEL_DIR)"

copy-perspective:
	@mkdir -p static/perspective
	@cp extensions/jupyterlab/hugr_perspective/labextension/static/perspective/* static/perspective/ 2>/dev/null || true
	@echo "Perspective static files copied to static/perspective/"

test: install
	uv run jupyter kernelspec list
	@echo "Kernel installed. Run 'uv run jupyter lab' to test."

build-jupyterlab:
	cd extensions/jupyterlab && jlpm install && jlpm build

build-vscode:
	cd extensions/vscode && npm install && npm run build

build-extensions: build-jupyterlab build-vscode

clean:
	rm -f $(BINARY)
	rm -rf static/
