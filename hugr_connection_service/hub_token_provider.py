"""Hub Token Provider — actively refreshes access_token via JupyterHub.

No refresh_token is stored in the container. JupyterHub manages the OIDC
refresh cycle; this provider periodically POSTs to a custom JH internal
endpoint that drives Authenticator.refresh_user() server-side and returns
the fresh access_token.

Why a custom endpoint and not /hub/api/users/{name}?
JupyterHub's auth_refresh_age background refresh fires lazily — only when
a request with a *user-cookie* hits JH (e.g. JupyterLab UI heartbeat). The
poller runs with a JUPYTERHUB_API_TOKEN (server scope), which doesn't
trigger refresh_user. So if the user closes the browser tab the access_token
dies and is never refreshed until the user comes back. The custom endpoint
forces refresh_auth(user, force=True) on every poll, decoupling the refresh
cycle from UI activity. Requires JupyterHub config to register
RefreshUserHandler (see jupyterhub_config.py in the hub repo).

Refresh scheduling is based on the JWT `exp` claim (30 seconds before expiry).
"""

import base64
import json
import logging
import os
import tempfile
import time
from pathlib import Path

import httpx
from tornado.ioloop import IOLoop

log = logging.getLogger("hugr_connection_service.hub_token_provider")

# In-memory token store: connection_name → {"access_token": str, "expires_at": int}
_hub_tokens: dict[str, dict] = {}


def get_hub_token(connection_name: str) -> dict | None:
    """Get current hub token from in-memory store. Used by ProxyHandler."""
    return _hub_tokens.get(connection_name)


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
    """Write config atomically (write to temp file, then rename)."""
    p = _config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(dir=p.parent, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(cfg, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, p)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _decode_jwt_exp(token: str) -> float | None:
    """Decode exp claim from JWT payload without signature verification."""
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload = parts[1]
        # Add padding
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += "=" * padding
        data = json.loads(base64.urlsafe_b64decode(payload))
        exp = data.get("exp")
        return float(exp) if exp is not None else None
    except Exception:
        return None


class HubTokenProvider:
    """Refreshes access_token by POSTing to JH's refresh-user endpoint.

    Token refresh scheduling is based on the JWT exp claim:
    - Schedule next refresh at exp - 30 seconds
    - Minimum delay: 5 seconds
    - On HTTP failure: exponential backoff (5s, 10s, 20s, 40s, max 60s)
    - On 410 Gone (refresh_token expired): write session-expired marker,
      stop polling. The browser/UI will discover the dead session on its
      next interaction with kernels.
    """

    def __init__(
        self,
        connection_name: str,
        initial_access_token: str | None = None,
        tls_skip_verify: bool = False,
    ):
        self.connection_name = connection_name
        self.hub_api_url = os.environ.get("JUPYTERHUB_API_URL", "")
        self.hub_token = os.environ.get("JUPYTERHUB_API_TOKEN", "")
        self.hub_user = os.environ.get("JUPYTERHUB_USER", "")
        self._tls_skip_verify = tls_skip_verify
        self._refresh_handle = None
        self._backoff_delay = 5
        self._last_token = None

        if initial_access_token:
            self._write_token(initial_access_token)
            self._last_token = initial_access_token

    def start(self):
        """Begin the token refresh polling loop."""
        if not self.hub_api_url or not self.hub_token:
            log.info(
                "No JUPYTERHUB_API_URL/TOKEN — hub token provider disabled "
                "(standalone mode, no JupyterHub)"
            )
            return

        # Schedule first refresh based on initial token expiry
        delay = self._delay_from_current_token()
        log.info(
            "Hub token provider started for %r, first refresh in %.0fs",
            self.connection_name,
            delay,
        )
        self._schedule(delay)

    def stop(self):
        """Cancel any pending refresh."""
        if self._refresh_handle is not None:
            IOLoop.current().remove_timeout(self._refresh_handle)
            self._refresh_handle = None

    def _delay_from_current_token(self) -> float:
        """Calculate delay until next refresh from current token's exp."""
        cfg = _load_config()
        for conn in cfg.get("connections", []):
            if conn.get("name") == self.connection_name:
                token = conn.get("tokens", {}).get("access_token")
                if token:
                    exp = _decode_jwt_exp(token)
                    if exp:
                        delay = exp - time.time() - 30
                        return max(delay, 5)
        # No token yet — poll soon
        return 10

    def _schedule(self, delay: float):
        """Schedule the next refresh call."""
        self.stop()
        self._refresh_handle = IOLoop.current().call_later(
            delay, self._do_refresh
        )

    async def _do_refresh(self):
        """Force a refresh in JH and pull the fresh access_token."""
        try:
            async with httpx.AsyncClient(verify=not self._tls_skip_verify) as client:
                resp = await client.post(
                    f"{self.hub_api_url}/internal/refresh-user/{self.hub_user}",
                    headers={"Authorization": f"Bearer {self.hub_token}"},
                    timeout=10,
                )

            # 410 Gone — refresh_user said False, fresh login required.
            # Stop polling, write a marker so other components / UI can react.
            if resp.status_code == 410:
                try:
                    reason = resp.json().get("reason", "fresh_login_required")
                except Exception:
                    reason = "fresh_login_required"
                log.warning(
                    "Session expired for %r (reason=%s). Polling stopped.",
                    self.connection_name,
                    reason,
                )
                self._write_session_expired_marker(reason)
                self.stop()
                return

            resp.raise_for_status()
            payload = resp.json()
            access_token = payload.get("access_token")

            if not access_token:
                log.warning("refresh-user endpoint returned no access_token")
                self._schedule(10)
                return

            # Same token — JH didn't actually rotate (e.g. existing token
            # still valid). Reschedule based on its exp.
            if access_token == self._last_token:
                exp = _decode_jwt_exp(access_token) or (payload.get("expires_at") or 0)
                delay = max(exp - time.time() - 30, 5) if exp else 30
                self._schedule(delay)
                return

            # New token — persist and reschedule based on its exp.
            self._write_token(access_token)
            self._last_token = access_token
            self._backoff_delay = 5  # reset backoff

            exp = _decode_jwt_exp(access_token) or (payload.get("expires_at") or 0)
            if exp:
                delay = max(exp - time.time() - 30, 5)
            else:
                delay = 240  # fallback: 4 minutes
            log.info(
                "Token refreshed for %r, next refresh in %.0fs",
                self.connection_name,
                delay,
            )
            self._schedule(delay)

        except Exception as e:
            log.warning(
                "Token refresh failed for %r: %s. Retrying in %ds",
                self.connection_name,
                e,
                self._backoff_delay,
            )
            self._schedule(self._backoff_delay)
            self._backoff_delay = min(self._backoff_delay * 2, 60)

    def _write_session_expired_marker(self, reason: str) -> None:
        """Write a marker file indicating the JH session is dead.

        Other components (Jupyter Server extensions, UI plugins) can watch
        for this file to surface a "session expired, please re-login" message
        to the user. Path is the connections.json directory + 'session-expired.flag'.
        """
        try:
            marker = _config_path().parent / "session-expired.flag"
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(
                json.dumps({
                    "reason": reason,
                    "at": int(time.time()),
                    "connection": self.connection_name,
                })
            )
        except Exception as e:
            log.warning("Failed to write session-expired marker: %s", e)

    def _write_token(self, access_token: str):
        """Write access_token + expires_at to in-memory store and connections.json."""
        exp = _decode_jwt_exp(access_token)
        token_data = {
            "access_token": access_token,
            "expires_at": int(exp) if exp else 0,
        }

        # Update in-memory store (used by ProxyHandler)
        _hub_tokens[self.connection_name] = token_data

        # Persist to disk (for kernel and restart recovery)
        cfg = _load_config()
        for conn in cfg.get("connections", []):
            if conn.get("name") == self.connection_name and conn.get("managed"):
                conn["tokens"] = token_data
                break
        _save_config(cfg)
