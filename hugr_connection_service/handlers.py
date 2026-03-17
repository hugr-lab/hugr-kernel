"""REST API handlers for Hugr connection management.

Reads/writes ~/.hugr/connections.json — same file as VS Code extension.
Uses hugr-client (HugrClient) for IPC multipart communication.
"""
import json
import os
from pathlib import Path

from jupyter_server.base.handlers import APIHandler, JupyterHandler
from jupyter_server.utils import url_path_join
import tornado.httpclient
import tornado.web


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


def _find_connection(cfg: dict, name: str):
    for c in cfg.get("connections", []):
        if c.get("name") == name:
            return c
    return None


def _test_connection(url: str, auth_type: str = "public", **kwargs) -> dict:
    """Test connection using HugrClient which handles IPC multipart responses."""
    from hugr.client import HugrClient

    try:
        client = HugrClient(
            url=url,
            api_key=kwargs.get("api_key") if auth_type == "api_key" else None,
            token=kwargs.get("token") if auth_type == "bearer" else None,
            role=kwargs.get("role"),
        )
        resp = client.query("{ function { core { info { version } } } }")
        # Extract version from the response
        for path, part in resp.parts.items():
            data = part.dict() if hasattr(part, "dict") else {}
            if isinstance(data, dict) and "version" in data:
                return {"ok": True, "version": data["version"]}
        return {"ok": True, "version": "unknown"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


class ProxyHandler(JupyterHandler):
    """POST /hugr/proxy/<connection_name> — proxy request to Hugr server."""

    @tornado.web.authenticated
    async def post(self, connection_name: str):
        cfg = _load_config()
        conn = _find_connection(cfg, connection_name)
        if not conn:
            self.set_status(404)
            self.finish(json.dumps({"error": "not found"}))
            return

        url = conn.get("url", "").rstrip("/")
        auth_type = conn.get("auth_type", "public")

        headers = {"Content-Type": "application/json"}
        if auth_type == "api_key" and conn.get("api_key"):
            headers["X-Api-Key"] = conn["api_key"]
        elif auth_type == "bearer" and conn.get("token"):
            headers["Authorization"] = f"Bearer {conn['token']}"
        if conn.get("role"):
            headers["X-Hugr-Role"] = conn["role"]

        client = tornado.httpclient.AsyncHTTPClient()
        try:
            response = await client.fetch(
                url,
                method="POST",
                headers=headers,
                body=self.request.body,
                request_timeout=30,
            )
        except tornado.httpclient.HTTPClientError as e:
            if e.response is not None:
                self.set_status(e.response.code)
                for name, value in e.response.headers.get_all():
                    if name.lower() not in ("transfer-encoding", "connection", "content-length"):
                        self.set_header(name, value)
                self.finish(e.response.body)
            else:
                self.set_status(502)
                self.finish(json.dumps({"error": f"connection error: {e}"}))
            return
        except Exception as e:
            if "timeout" in str(e).lower():
                self.set_status(504)
                self.finish(json.dumps({"error": f"gateway timeout: {e}"}))
            else:
                self.set_status(502)
                self.finish(json.dumps({"error": f"connection error: {e}"}))
            return

        self.set_status(response.code)
        for name, value in response.headers.get_all():
            if name.lower() not in ("transfer-encoding", "connection", "content-length"):
                self.set_header(name, value)
        self.finish(response.body)


class ConnectionsHandler(APIHandler):
    """GET /hugr/connections — list all connections.
    POST /hugr/connections — add a new connection.
    """

    @tornado.web.authenticated
    def get(self):
        cfg = _load_config()
        default_name = cfg.get("default", "")
        connections = cfg.get("connections", [])
        result = []
        for c in connections:
            result.append({
                "name": c.get("name", ""),
                "url": c.get("url", ""),
                "auth_type": c.get("auth_type", "public"),
                "role": c.get("role"),
                "read_only": False,
                "status": "default" if c.get("name") == default_name else "connected",
            })
        self.finish(json.dumps(result))

    @tornado.web.authenticated
    def post(self):
        body = json.loads(self.request.body)
        name = body.get("name", "").strip()
        url = body.get("url", "").strip()
        if not name or not url:
            self.set_status(400)
            self.finish(json.dumps({"error": "name and url are required"}))
            return

        cfg = _load_config()
        if _find_connection(cfg, name):
            self.set_status(409)
            self.finish(json.dumps({"error": f"connection '{name}' already exists"}))
            return

        entry = {"name": name, "url": url, "auth_type": body.get("auth_type", "public")}
        if body.get("role"):
            entry["role"] = body["role"]
        cfg.setdefault("connections", []).append(entry)
        if not cfg.get("default"):
            cfg["default"] = name
        _save_config(cfg)
        self.set_status(201)
        self.finish(json.dumps(entry))


class ConnectionHandler(APIHandler):
    """PUT /hugr/connections/<name> — update a connection.
    DELETE /hugr/connections/<name> — delete a connection.
    """

    @tornado.web.authenticated
    def put(self, name: str):
        cfg = _load_config()
        conn = _find_connection(cfg, name)
        if not conn:
            self.set_status(404)
            self.finish(json.dumps({"error": "not found"}))
            return

        body = json.loads(self.request.body)
        conn["url"] = body.get("url", conn["url"])
        conn["auth_type"] = body.get("auth_type", conn.get("auth_type", "public"))
        if body.get("role"):
            conn["role"] = body["role"]
        _save_config(cfg)
        self.finish(json.dumps(conn))

    @tornado.web.authenticated
    def delete(self, name: str):
        cfg = _load_config()
        connections = cfg.get("connections", [])
        cfg["connections"] = [c for c in connections if c.get("name") != name]
        if cfg.get("default") == name:
            cfg["default"] = cfg["connections"][0]["name"] if cfg["connections"] else ""
        _save_config(cfg)
        self.set_status(204)
        self.finish()


class ConnectionDefaultHandler(APIHandler):
    """PUT /hugr/connections/<name>/default — set a connection as default."""

    @tornado.web.authenticated
    def put(self, name: str):
        cfg = _load_config()
        conn = _find_connection(cfg, name)
        if not conn:
            self.set_status(404)
            self.finish(json.dumps({"error": "not found"}))
            return

        cfg["default"] = name
        _save_config(cfg)
        self.finish(json.dumps({"ok": True, "default": name}))


class ConnectionTestHandler(APIHandler):
    """POST /hugr/connections/<name>/test — test a named connection."""

    @tornado.web.authenticated
    def post(self, name: str):
        cfg = _load_config()
        conn = _find_connection(cfg, name)
        if not conn:
            self.set_status(404)
            self.finish(json.dumps({"error": "not found"}))
            return

        result = _test_connection(
            conn["url"],
            auth_type=conn.get("auth_type", "public"),
            api_key=conn.get("api_key"),
            token=conn.get("token"),
            role=conn.get("role"),
        )
        self.finish(json.dumps(result))


class TestHandler(APIHandler):
    """POST /hugr/test — test an ad-hoc connection (not saved)."""

    @tornado.web.authenticated
    def post(self):
        body = json.loads(self.request.body)
        url = body.get("url", "").strip()
        if not url:
            self.set_status(400)
            self.finish(json.dumps({"error": "url is required"}))
            return

        result = _test_connection(
            url,
            auth_type=body.get("auth_type", "public"),
            api_key=body.get("api_key"),
            token=body.get("token"),
            role=body.get("role"),
        )
        self.finish(json.dumps(result))


def setup_handlers(web_app):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]
    route = lambda pattern: url_path_join(base_url, "hugr", pattern)

    web_app.add_handlers(host_pattern, [
        (route(r"proxy/([^/]+)"), ProxyHandler),
        (route("connections"), ConnectionsHandler),
        (route(r"connections/([^/]+)/default"), ConnectionDefaultHandler),
        (route(r"connections/([^/]+)/test"), ConnectionTestHandler),
        (route(r"connections/([^/]+)"), ConnectionHandler),
        (route("test"), TestHandler),
    ])
