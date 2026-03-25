#!/usr/bin/env bash
set -euo pipefail

REPO="hugr-lab/hugr-kernel"
KERNEL_NAME="hugr"

# Detect OS and arch
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
    arm64)   ARCH="arm64" ;;
    *)       echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

case "$OS" in
    linux|darwin) ;;
    mingw*|msys*|cygwin*) OS="windows" ;;
    *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

SUFFIX=""
if [ "$OS" = "windows" ]; then
    SUFFIX=".exe"
fi

BINARY="hugr-kernel-${OS}-${ARCH}${SUFFIX}"

# Determine version
VERSION="${1:-latest}"
if [ "$VERSION" = "latest" ]; then
    echo "Fetching latest release..."
    VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    if [ -z "$VERSION" ]; then
        echo "Failed to determine latest version" >&2
        exit 1
    fi
fi
echo "Installing hugr-kernel ${VERSION} (${OS}/${ARCH})"

# Determine Jupyter kernel directory
if [ "$OS" = "darwin" ]; then
    KERNEL_DIR="${HOME}/Library/Jupyter/kernels/${KERNEL_NAME}"
elif [ "$OS" = "windows" ]; then
    KERNEL_DIR="${APPDATA}/jupyter/kernels/${KERNEL_NAME}"
else
    KERNEL_DIR="${HOME}/.local/share/jupyter/kernels/${KERNEL_NAME}"
fi

mkdir -p "$KERNEL_DIR"

# Download binary
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY}"
echo "Downloading ${DOWNLOAD_URL}..."
curl -fSL -o "${KERNEL_DIR}/hugr-kernel${SUFFIX}" "$DOWNLOAD_URL"
chmod +x "${KERNEL_DIR}/hugr-kernel${SUFFIX}"

# Download kernel.json
KERNEL_JSON_URL="https://github.com/${REPO}/releases/download/${VERSION}/kernel.json"
curl -fSL -o "${KERNEL_DIR}/kernel.json" "$KERNEL_JSON_URL"

# Patch kernel.json with absolute path
BINARY_PATH="${KERNEL_DIR}/hugr-kernel${SUFFIX}"
if command -v python3 &>/dev/null; then
    KERNEL_JSON="${KERNEL_DIR}/kernel.json" KERNEL_BINARY="${BINARY_PATH}" python3 -c "
import json, os
path = os.environ['KERNEL_JSON']
with open(path) as f:
    spec = json.load(f)
spec['argv'][0] = os.environ['KERNEL_BINARY']
with open(path, 'w') as f:
    json.dump(spec, f, indent=2)
"
else
    sed -i'' -e "s|\"hugr-kernel\"|\"${BINARY_PATH}\"|" "${KERNEL_DIR}/kernel.json"
fi

# Download kernel logos
for LOGO in logo-32x32.png logo-64x64.png; do
    LOGO_URL="https://github.com/${REPO}/releases/download/${VERSION}/${LOGO}"
    if curl -fSL -o "${KERNEL_DIR}/${LOGO}" "$LOGO_URL" 2>/dev/null; then
        true
    else
        echo "Warning: Could not download ${LOGO} (non-fatal)"
    fi
done

# Download and extract Perspective viewer static files (for VS Code built-in viewer)
STATIC_URL="https://github.com/${REPO}/releases/download/${VERSION}/perspective-static.tar.gz"
echo "Downloading Perspective viewer assets..."
if curl -fSL -o "${KERNEL_DIR}/perspective-static.tar.gz" "$STATIC_URL" 2>/dev/null; then
    mkdir -p "${KERNEL_DIR}/static"
    tar -xzf "${KERNEL_DIR}/perspective-static.tar.gz" -C "${KERNEL_DIR}/static"
    rm -f "${KERNEL_DIR}/perspective-static.tar.gz"
    echo "Perspective viewer assets installed"
else
    echo "Warning: Could not download Perspective viewer assets (non-fatal)"
    echo "  VS Code result rendering may fall back to plain text"
fi

echo ""
echo "hugr-kernel ${VERSION} installed to ${KERNEL_DIR}"
echo ""

# Install JupyterLab extensions via pip (if available)
VERSION_NUM="${VERSION#v}"
if command -v pip &>/dev/null; then
    echo "Installing JupyterLab extensions..."
    pip install "hugr-perspective-viewer>=0.3.0" 2>/dev/null && \
        echo "  Installed: hugr-perspective-viewer (spool proxy + result viewer)" || \
        echo "  Warning: Could not install hugr-perspective-viewer (non-fatal)"
    pip install "hugr-graphql-ide>=${VERSION_NUM}" 2>/dev/null && \
        echo "  Installed: hugr-graphql-ide (GraphQL IDE, connection manager)" || \
        echo "  Warning: Could not install hugr-graphql-ide (non-fatal)"
    echo ""
fi

echo "Verify with:"
echo "  jupyter kernelspec list"
echo "  jupyter labextension list"
echo "  jupyter server extension list"
