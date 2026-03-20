"""Hugr Connection Service — Jupyter server extension for managing Hugr connections."""


def _jupyter_server_extension_points():
    return [{"module": "hugr_connection_service"}]


def _load_jupyter_server_extension(server_app):
    from .handlers import setup_handlers
    from . import oidc
    setup_handlers(server_app.web_app)
    try:
        oidc.restore_sessions_on_startup()
    except Exception as e:
        server_app.log.warning("OIDC session restore failed: %s", e)
    server_app.log.info("hugr_connection_service extension loaded")
