"""REST API handlers for Hugr connection management.

Reads/writes ~/.hugr/connections.json — same file as VS Code extension.
Uses hugr-client (HugrClient) for IPC multipart communication.
"""
import json
import os
import time
from pathlib import Path

from jupyter_server.base.handlers import APIHandler, JupyterHandler
from jupyter_server.utils import url_path_join
import tornado.httpclient
import tornado.web

# In-memory storage for browser auth test results
# test_id → {"status": "pending"/"ok"/"error", "version": "...", "error": "..."}
_test_results: dict[str, dict] = {}
_TEMP_PREFIX = "__test_"


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
            api_key_header=kwargs.get("api_key_header") if auth_type == "api_key" else None,
            token=kwargs.get("token") if auth_type in ("bearer", "hub", "browser") else None,
            role=kwargs.get("role"),
            tls_skip_verify=kwargs.get("tls_skip_verify", False),
        )
        resp = client.query("{ function { core { info { version } } } }")
        for path, part in resp.parts.items():
            data = part.dict() if hasattr(part, "dict") else {}
            if isinstance(data, dict) and "version" in data:
                return {"ok": True, "version": data["version"]}
        return {"ok": True, "version": "unknown"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


_proxy_name: str | None = None
_proxy_conn: dict | None = None

def _parse_duration(v: str, default: float = 300) -> float:
    """Parse Go duration format subset ('5m', '300s', '1h'). Returns seconds."""
    try:
        if v.endswith("h"):
            return float(v[:-1]) * 3600
        if v.endswith("m"):
            return float(v[:-1]) * 60
        if v.endswith("s"):
            return float(v[:-1])
        return float(v)
    except (ValueError, IndexError):
        return default

_query_timeout: float = _parse_duration(os.environ.get("HUGR_QUERY_TIMEOUT", "5m"))


class ProxyHandler(JupyterHandler):
    """POST /hugr/proxy/<connection_name> — proxy request to Hugr server."""

    @tornado.web.authenticated
    async def post(self, connection_name: str):
        global _proxy_name, _proxy_conn
        try:
            if _proxy_name != connection_name:
                cfg = _load_config()
                _proxy_conn = _find_connection(cfg, connection_name)
                _proxy_name = connection_name
        except Exception as e:
            import traceback
            self.log.error("Proxy config error: %s\n%s", e, traceback.format_exc())
            self.set_status(500)
            self.finish(json.dumps({"error": f"config error: {e}"}))
            return
        conn = _proxy_conn
        if not conn:
            self.set_status(404)
            self.finish(json.dumps({"error": "not found"}))
            return

        url = conn.get("url", "").rstrip("/")
        auth_type = conn.get("auth_type", "public")

        headers = {"Content-Type": "application/json"}
        if auth_type == "api_key" and conn.get("api_key"):
            header_name = conn.get("api_key_header", "X-Api-Key")
            headers[header_name] = conn["api_key"]
        elif auth_type == "bearer" and conn.get("token"):
            headers["Authorization"] = f"Bearer {conn['token']}"
        elif auth_type == "browser":
            from . import oidc
            token_data = oidc.get_token(connection_name)
            if token_data:
                headers["Authorization"] = f"Bearer {token_data['access_token']}"
            elif conn.get("tokens", {}).get("access_token"):
                headers["Authorization"] = f"Bearer {conn['tokens']['access_token']}"
        elif auth_type == "hub":
            from .hub_token_provider import get_hub_token
            hub_token_data = get_hub_token(connection_name)
            token = hub_token_data["access_token"] if hub_token_data else conn.get("tokens", {}).get("access_token")
            if token:
                headers["Authorization"] = f"Bearer {token}"
            else:
                self.set_status(401)
                self.finish(json.dumps({"error": "Hub token not yet available, waiting for refresh..."}))
                return
        if conn.get("role"):
            headers["X-Hugr-Role"] = conn["role"]

        tls_skip = conn.get("tls_skip_verify", False)
        client = tornado.httpclient.AsyncHTTPClient()
        try:
            response = await client.fetch(
                url,
                method="POST",
                headers=headers,
                body=self.request.body,
                request_timeout=_query_timeout,
                validate_cert=not tls_skip,
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
        from . import oidc
        for c in connections:
            entry = {
                "name": c.get("name", ""),
                "url": c.get("url", ""),
                "auth_type": c.get("auth_type", "public"),
                "role": c.get("role"),
                "managed": c.get("managed", False),
                "read_only": c.get("managed", False),
                "status": "default" if c.get("name") == default_name else "connected",
            }
            if c.get("api_key"):
                entry["api_key"] = c["api_key"]
            if c.get("api_key_header"):
                entry["api_key_header"] = c["api_key_header"]
            if c.get("token"):
                entry["token"] = c["token"]
            if c.get("auth_type") == "hub":
                token = c.get("tokens", {}).get("access_token")
                entry["authenticated"] = bool(token)
                expires_at = c.get("tokens", {}).get("expires_at")
                if expires_at:
                    entry["expires_at"] = expires_at
            elif c.get("auth_type") == "browser":
                auth_status = oidc.is_authenticated(c.get("name", ""))
                entry["authenticated"] = auth_status["authenticated"]
                if auth_status.get("expires_at"):
                    entry["expires_at"] = auth_status["expires_at"]
                if c.get("oidc"):
                    entry["was_authenticated"] = True
            entry["query_timeout"] = _query_timeout
            result.append(entry)
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
        existing = _find_connection(cfg, name)
        if existing:
            if existing.get("managed"):
                self.set_status(409)
                self.finish(json.dumps({"error": f"Name '{name}' is reserved for hub-managed connection"}))
                return
            self.set_status(409)
            self.finish(json.dumps({"error": f"connection '{name}' already exists"}))
            return

        entry = {"name": name, "url": url, "auth_type": body.get("auth_type", "public")}
        if body.get("api_key"):
            entry["api_key"] = body["api_key"]
        if body.get("api_key_header"):
            entry["api_key_header"] = body["api_key_header"]
        if body.get("token"):
            entry["token"] = body["token"]
        if body.get("role"):
            entry["role"] = body["role"]
        if body.get("tls_skip_verify"):
            entry["tls_skip_verify"] = True
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

        if conn.get("managed"):
            self.set_status(403)
            self.finish(json.dumps({"error": "Cannot modify hub-managed connection"}))
            return

        body = json.loads(self.request.body)
        conn["url"] = body.get("url", conn["url"])
        conn["auth_type"] = body.get("auth_type", conn.get("auth_type", "public"))
        if "api_key" in body:
            conn["api_key"] = body["api_key"]
        if "api_key_header" in body:
            conn["api_key_header"] = body["api_key_header"]
        if "token" in body:
            conn["token"] = body["token"]
        if body.get("role"):
            conn["role"] = body["role"]
        if "tls_skip_verify" in body:
            conn["tls_skip_verify"] = bool(body["tls_skip_verify"])
        _save_config(cfg)
        self.finish(json.dumps(conn))

    @tornado.web.authenticated
    def delete(self, name: str):
        cfg = _load_config()
        conn = _find_connection(cfg, name)
        if conn and conn.get("managed"):
            self.set_status(403)
            self.finish(json.dumps({"error": "Cannot delete hub-managed connection"}))
            return

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

        auth_type = conn.get("auth_type", "public")
        token = conn.get("token")
        if auth_type == "hub":
            token = (conn.get("tokens") or {}).get("access_token")
        elif auth_type == "browser":
            from . import oidc
            token_data = oidc.get_token(name)
            if token_data:
                token = token_data.get("access_token")
            elif (conn.get("tokens") or {}).get("access_token"):
                token = conn["tokens"]["access_token"]
        result = _test_connection(
            conn["url"],
            auth_type=auth_type,
            api_key=conn.get("api_key"),
            api_key_header=conn.get("api_key_header"),
            token=token,
            role=conn.get("role"),
            tls_skip_verify=conn.get("tls_skip_verify", False),
        )
        self.finish(json.dumps(result))


class TestHandler(APIHandler):
    """POST /hugr/test — test an ad-hoc connection (not saved).

    For browser auth: starts login flow, returns {auth_url, test_id}.
    After callback, test query runs automatically using in-memory token.
    Poll GET /hugr/test/<test_id> for result.
    """

    @tornado.web.authenticated
    def post(self):
        body = json.loads(self.request.body)
        url = body.get("url", "").strip()
        if not url:
            self.set_status(400)
            self.finish(json.dumps({"error": "url is required"}))
            return

        auth_type = body.get("auth_type", "public")

        if auth_type == "browser":
            test_id = f"{_TEMP_PREFIX}{int(time.time() * 1000)}"
            _test_results[test_id] = {"status": "pending", "url": url}

            from . import oidc
            base_url = self.settings.get("base_url", "/")
            callback_base = f"{self.request.protocol}://{self.request.host}{base_url.rstrip('/')}"
            try:
                auth_url = oidc.start_login(test_id, url, callback_base, tls_skip_verify=body.get("tls_skip_verify", False))
            except ValueError as e:
                _test_results.pop(test_id, None)
                self.set_status(400)
                self.finish(json.dumps({"error": str(e)}))
                return

            self.finish(json.dumps({"auth_url": auth_url, "test_id": test_id}))
            return

        result = _test_connection(
            url,
            auth_type=auth_type,
            api_key=body.get("api_key"),
            api_key_header=body.get("api_key_header"),
            token=body.get("token"),
            role=body.get("role"),
            tls_skip_verify=body.get("tls_skip_verify", False),
        )
        self.finish(json.dumps(result))


class TestResultHandler(APIHandler):
    """GET /hugr/test/<test_id> — poll for browser auth test result."""

    @tornado.web.authenticated
    def get(self, test_id: str):
        result = _test_results.get(test_id)
        if not result:
            self.set_status(404)
            self.finish(json.dumps({"error": "not found"}))
            return
        self.finish(json.dumps(result))
        # Cleanup if done
        if result.get("status") in ("ok", "error"):
            _test_results.pop(test_id, None)


class ConnectionLoginHandler(APIHandler):
    """POST /hugr/connections/<name>/login — start OIDC browser login."""

    @tornado.web.authenticated
    def post(self, name: str):
        cfg = _load_config()
        conn = _find_connection(cfg, name)
        if not conn:
            self.set_status(404)
            self.finish(json.dumps({"error": "not found"}))
            return

        if conn.get("auth_type") != "browser":
            self.set_status(400)
            self.finish(json.dumps({"error": "connection is not browser auth type"}))
            return

        from . import oidc

        # Build callback base URL from the current request
        base_url = self.settings.get("base_url", "/")
        callback_base = f"{self.request.protocol}://{self.request.host}{base_url.rstrip('/')}"

        try:
            auth_url = oidc.start_login(name, conn["url"], callback_base, tls_skip_verify=conn.get("tls_skip_verify", False))
        except ValueError as e:
            self.set_status(409 if "already in progress" in str(e) else 400)
            self.finish(json.dumps({"error": str(e)}))
            return

        self.finish(json.dumps({"auth_url": auth_url}))


class OAuthLogoutCallbackHandler(JupyterHandler):
    """GET /hugr/oauth/logout — post-logout redirect target, closes the tab."""

    def check_xsrf_cookie(self):
        pass

    def get(self):
        self.finish(
            "<html><body>"
            "<h2>Logged out</h2>"
            "<p>You can close this tab and return to JupyterLab.</p>"
            "<script>window.close()</script>"
            "</body></html>"
        )


class OAuthCallbackHandler(JupyterHandler):
    """GET /hugr/oauth/callback — handle OIDC redirect callback."""

    def check_xsrf_cookie(self):
        # Callback comes from external redirect, skip XSRF check
        pass

    def get(self):
        code = self.get_argument("code", None)
        state = self.get_argument("state", None)
        error = self.get_argument("error", None)

        if error:
            self.set_status(400)
            self.finish(f"<html><body><h2>Login failed</h2><p>{error}</p></body></html>")
            return

        if not code or not state:
            self.set_status(400)
            self.finish("<html><body><h2>Missing code or state parameter</h2></body></html>")
            return

        from . import oidc

        try:
            session = oidc.exchange_code(state, code)
        except ValueError as e:
            self.set_status(400)
            self.finish(f"<html><body><h2>Login failed</h2><p>{e}</p></body></html>")
            return

        # If this is a test connection, run test query and cleanup
        conn_name = session.connection_name
        if conn_name.startswith(_TEMP_PREFIX) and conn_name in _test_results:
            test_info = _test_results[conn_name]
            url = test_info.get("url", "")
            try:
                result = _test_connection(
                    url,
                    auth_type="bearer",
                    token=session.access_token,
                    tls_skip_verify=session.tls_skip_verify,
                )
                _test_results[conn_name] = result
            except Exception as e:
                _test_results[conn_name] = {"status": "error", "error": str(e)}
            # Cleanup: remove session, no file to clean
            oidc.logout(conn_name)

            ok = _test_results[conn_name].get("ok", False)
            version = _test_results[conn_name].get("version", "")
            msg = f"v{version}" if ok else _test_results[conn_name].get("error", "failed")
            color = "#28a745" if ok else "#dc3545"
            self.finish(
                "<html><body>"
                f'<h2 style="color:{color}">Test: {msg}</h2>'
                "<p>You can close this tab and return to JupyterLab.</p>"
                "<script>window.close()</script>"
                "</body></html>"
            )
            return

        self.finish(
            "<html><body>"
            "<h2>Login successful</h2>"
            "<p>You can close this tab and return to JupyterLab.</p>"
            "<script>window.close()</script>"
            "</body></html>"
        )


class ConnectionAuthHandler(APIHandler):
    """GET /hugr/connections/<name>/auth — check auth status."""

    @tornado.web.authenticated
    def get(self, name: str):
        cfg = _load_config()
        conn = _find_connection(cfg, name)
        if not conn:
            self.set_status(404)
            self.finish(json.dumps({"error": "not found"}))
            return

        from . import oidc
        status = oidc.is_authenticated(name)
        self.finish(json.dumps(status))


class ConnectionLogoutHandler(APIHandler):
    """POST /hugr/connections/<name>/logout — clear tokens and stop refresh."""

    @tornado.web.authenticated
    def post(self, name: str):
        cfg = _load_config()
        conn = _find_connection(cfg, name)
        if not conn:
            self.set_status(404)
            self.finish(json.dumps({"error": "not found"}))
            return

        from . import oidc
        base_url = self.settings.get("base_url", "/")
        post_logout_redirect = f"{self.request.protocol}://{self.request.host}{base_url.rstrip('/')}/hugr/oauth/logout"
        result = oidc.logout(name, post_logout_redirect=post_logout_redirect)
        resp = {"status": "logged_out"}
        if result and result.get("end_session_url"):
            resp["end_session_url"] = result["end_session_url"]
        self.finish(json.dumps(resp))


class ConnectionTokenHandler(APIHandler):
    """GET /hugr/connections/<name>/token — get current access token."""

    @tornado.web.authenticated
    def get(self, name: str):
        cfg = _load_config()
        conn = _find_connection(cfg, name)
        if not conn:
            self.set_status(404)
            self.finish(json.dumps({"error": "not found"}))
            return

        auth_type = conn.get("auth_type", "public")

        # Hub auth: token from in-memory store (refreshed by hub_token_provider)
        if auth_type == "hub":
            from .hub_token_provider import get_hub_token
            hub_token_data = get_hub_token(name)
            if not hub_token_data:
                # Fallback to connections.json
                tokens = conn.get("tokens") or {}
                hub_token_data = {"access_token": tokens.get("access_token"), "expires_at": tokens.get("expires_at", 0)}
            if hub_token_data and hub_token_data.get("access_token"):
                self.finish(json.dumps(hub_token_data))
            else:
                self.set_status(404)
                self.finish(json.dumps({"error": "hub token not yet available"}))
            return

        # Browser OIDC: token from in-memory session
        from . import oidc
        token_data = oidc.get_token(name)
        if not token_data:
            self.set_status(404)
            self.finish(json.dumps({"error": "no active session"}))
            return

        self.finish(json.dumps(token_data))


class ConnectionDiscoverHandler(APIHandler):
    """POST /hugr/connections/<name>/discover — check if OIDC is available."""

    @tornado.web.authenticated
    def post(self, name: str):
        cfg = _load_config()
        conn = _find_connection(cfg, name)
        if not conn:
            self.set_status(404)
            self.finish(json.dumps({"error": "not found"}))
            return

        from . import oidc
        auth_config = oidc.discover_auth_config(conn["url"], tls_skip_verify=conn.get("tls_skip_verify", False))
        if auth_config:
            self.finish(json.dumps({"oidc_available": True, **auth_config}))
        else:
            self.finish(json.dumps({"oidc_available": False}))


class DiscoverHandler(APIHandler):
    """POST /hugr/discover — check if OIDC is available for a given URL."""

    @tornado.web.authenticated
    def post(self):
        body = json.loads(self.request.body)
        url = body.get("url", "").strip()
        if not url:
            self.set_status(400)
            self.finish(json.dumps({"error": "url is required"}))
            return

        from . import oidc
        auth_config = oidc.discover_auth_config(url, tls_skip_verify=body.get("tls_skip_verify", False))
        if auth_config:
            self.finish(json.dumps({"oidc_available": True, **auth_config}))
        else:
            self.finish(json.dumps({"oidc_available": False}))


def setup_handlers(web_app):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]
    route = lambda pattern: url_path_join(base_url, "hugr", pattern)

    web_app.add_handlers(host_pattern, [
        # Connection management endpoints
        (route(r"proxy/([^/]+)"), ProxyHandler),
        (route("connections"), ConnectionsHandler),
        (route(r"connections/([^/]+)/default"), ConnectionDefaultHandler),
        (route(r"connections/([^/]+)/test"), ConnectionTestHandler),
        (route(r"connections/([^/]+)/login"), ConnectionLoginHandler),
        (route(r"connections/([^/]+)/logout"), ConnectionLogoutHandler),
        (route(r"connections/([^/]+)/auth"), ConnectionAuthHandler),
        (route(r"connections/([^/]+)/token"), ConnectionTokenHandler),
        (route(r"connections/([^/]+)/discover"), ConnectionDiscoverHandler),
        (route(r"connections/([^/]+)"), ConnectionHandler),
        (route("oauth/callback"), OAuthCallbackHandler),
        (route("oauth/logout"), OAuthLogoutCallbackHandler),
        (route("discover"), DiscoverHandler),
        (route(r"test/([^/]+)"), TestResultHandler),
        (route("test"), TestHandler),
    ])
