"""Hugr Connection Service — Jupyter server extension for managing Hugr connections."""

import json
import logging
import os
from pathlib import Path

log = logging.getLogger("hugr_connection_service")


def _jupyter_server_extension_points():
    return [{"module": "hugr_connection_service"}]


def _config_path() -> Path:
    env = os.environ.get("HUGR_CONFIG_PATH")
    if env:
        return Path(env)
    return Path.home() / ".hugr" / "connections.json"


def _load_config() -> dict:
    p = _config_path()
    if not p.exists():
        return {"connections": [], "default": ""}
    return json.loads(p.read_text())


def _save_config(cfg: dict) -> None:
    p = _config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cfg, indent=2) + "\n")


def _ensure_managed_connection(name: str, hugr_base_url: str, auth_type: str = "hub",
                                extra_fields: dict | None = None):
    """Create or update managed connection in connections.json.

    Called on EVERY container start (new or existing).
    Always overwrites URL from env — ensures config matches current Hub settings.
    Clears stale tokens if URL changed (token from old Hugr is invalid).
    Appends /ipc to base URL — kernels and hugr-client use the IPC endpoint.
    """
    ipc_url = hugr_base_url.rstrip("/") + "/ipc"

    cfg = _load_config()
    connections = cfg.get("connections", [])

    for conn in connections:
        if conn.get("name") == name and conn.get("managed"):
            old_url = conn.get("url")
            conn["url"] = ipc_url
            conn["auth_type"] = auth_type
            cfg["default"] = name

            if extra_fields:
                conn.update(extra_fields)

            # URL changed → clear stale tokens
            if old_url != ipc_url:
                conn.pop("tokens", None)
                log.info("Managed connection URL changed: %s → %s, tokens cleared",
                         old_url, ipc_url)

            _save_config(cfg)
            return

    # First start — create new managed connection
    entry = {
        "name": name,
        "url": ipc_url,
        "auth_type": auth_type,
        "managed": True,
    }
    if extra_fields:
        entry.update(extra_fields)

    connections.append(entry)
    cfg["connections"] = connections
    cfg["default"] = name
    _save_config(cfg)
    log.info("Created managed connection %r → %s (auth_type=%s)", name, ipc_url, auth_type)


def _detect_hugr_auth_type(hugr_base_url: str) -> str:
    """Check if Hugr has OIDC configured via GET /auth/config.

    Returns "browser" if OIDC is available (user can login via browser),
    "public" otherwise.
    """
    try:
        import httpx
        resp = httpx.get(f"{hugr_base_url}/auth/config", timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("issuer"):
                return "browser"
    except Exception as e:
        log.debug("Could not detect Hugr auth config: %s", e)
    return "public"


def _initialize_hub_mode(server_app):
    """Initialize Hub-managed connection from environment variables.

    When HUGR_URL is set, creates a managed connection that:
    - Cannot be deleted/modified by the user
    - URL is always updated from env on container start
    - Token is refreshed by polling JupyterHub API (based on JWT exp)

    If JUPYTERHUB_API_URL is not set (local dev without JupyterHub),
    creates a managed connection with auth_type "public" (assumes
    Hugr is configured with anonymous access for dev).
    """
    hugr_url = os.environ.get("HUGR_URL")
    if not hugr_url:
        return

    connection_name = os.environ.get("HUGR_CONNECTION_NAME", "default")
    initial_token = os.environ.get("HUGR_INITIAL_ACCESS_TOKEN")
    has_jupyterhub = bool(os.environ.get("JUPYTERHUB_API_URL"))

    if has_jupyterhub:
        # Running inside JupyterHub — use hub auth with token polling
        _ensure_managed_connection(
            name=connection_name,
            hugr_base_url=hugr_url,
            auth_type="hub",
        )

        from .hub_token_provider import HubTokenProvider

        provider = HubTokenProvider(
            connection_name=connection_name,
            initial_access_token=initial_token,
        )
        provider.start()
        log.info("Hub mode: OIDC token refresh via JupyterHub API")

    else:
        # No JupyterHub — check if Hugr has OIDC configured
        auth_type = _detect_hugr_auth_type(hugr_url)
        _ensure_managed_connection(
            name=connection_name,
            hugr_base_url=hugr_url,
            auth_type=auth_type,
        )
        log.info("Hub mode: %s auth (no JupyterHub)", auth_type)


def _load_jupyter_server_extension(server_app):
    from .handlers import setup_handlers
    from . import oidc

    setup_handlers(server_app.web_app)

    # Hub mode initialization (managed connections)
    try:
        _initialize_hub_mode(server_app)
    except Exception as e:
        server_app.log.warning("Hub mode initialization failed: %s", e)

    # Restore user's own OIDC sessions (non-managed connections)
    try:
        oidc.restore_sessions_on_startup()
    except Exception as e:
        server_app.log.warning("OIDC session restore failed: %s", e)

    server_app.log.info("hugr_connection_service extension loaded")
