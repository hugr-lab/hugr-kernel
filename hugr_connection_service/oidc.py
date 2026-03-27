"""OIDC Authorization Code + PKCE flow for browser-based authentication.

Handles discovery, PKCE generation, token exchange, and proactive refresh.
Refresh tokens are held in memory only — never persisted to disk.
"""
import hashlib
import json
import logging
import os
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx
from tornado.ioloop import IOLoop

log = logging.getLogger(__name__)

# In-memory state for active login sessions
_sessions: dict[str, "LoginSession"] = {}
# Pending login flows (state → PendingLogin)
_pending: dict[str, "PendingLogin"] = {}


class PendingLogin:
    """Tracks an in-progress OIDC login before callback is received."""

    def __init__(self, connection_name: str, code_verifier: str,
                 token_endpoint: str, client_id: str, redirect_uri: str,
                 issuer: str, tls_skip_verify: bool = False):
        self.connection_name = connection_name
        self.code_verifier = code_verifier
        self.token_endpoint = token_endpoint
        self.client_id = client_id
        self.redirect_uri = redirect_uri
        self.issuer = issuer
        self.tls_skip_verify = tls_skip_verify
        self.created_at = time.time()


class LoginSession:
    """Active OIDC session with refresh capability."""

    def __init__(self, connection_name: str, refresh_token: str,
                 access_token: str, expires_at: float,
                 token_endpoint: str, client_id: str, issuer: str,
                 tls_skip_verify: bool = False):
        self.connection_name = connection_name
        self.refresh_token = refresh_token
        self.access_token = access_token
        self.expires_at = expires_at
        self.token_endpoint = token_endpoint
        self.client_id = client_id
        self.issuer = issuer
        self.tls_skip_verify = tls_skip_verify
        self._refresh_handle = None

    def start_refresh_timer(self):
        """Schedule proactive refresh 30 seconds before token expiry."""
        self.cancel_refresh_timer()
        delay = max(self.expires_at - time.time() - 30, 1)
        self._refresh_handle = IOLoop.current().call_later(delay, self._do_refresh)
        log.info("Refresh timer for %r in %.0fs", self.connection_name, delay)

    def cancel_refresh_timer(self):
        if self._refresh_handle is not None:
            IOLoop.current().remove_timeout(self._refresh_handle)
            self._refresh_handle = None

    def _do_refresh(self):
        """Execute token refresh."""
        self._refresh_handle = None
        try:
            with httpx.Client(timeout=10, verify=not self.tls_skip_verify) as client:
                resp = client.post(self.token_endpoint, data={
                    "grant_type": "refresh_token",
                    "refresh_token": self.refresh_token,
                    "client_id": self.client_id,
                })
            if resp.status_code != 200:
                log.warning("Refresh failed for %r: %s", self.connection_name, resp.text)
                self._on_refresh_failure()
                return

            tokens = resp.json()
            self.access_token = tokens["access_token"]
            self.expires_at = time.time() + tokens.get("expires_in", 300)
            if "refresh_token" in tokens:
                self.refresh_token = tokens["refresh_token"]

            _write_tokens(self.connection_name, self.access_token, self.expires_at,
                         oidc_meta={
                             "issuer": self.issuer,
                             "client_id": self.client_id,
                             "token_endpoint": self.token_endpoint,
                         } if self.token_endpoint else None)
            log.info("Refreshed token for %r, expires in %ds",
                     self.connection_name, tokens.get("expires_in", 300))
            self.start_refresh_timer()

        except Exception as e:
            log.error("Refresh error for %r: %s", self.connection_name, e)
            self._on_refresh_failure()

    def _on_refresh_failure(self):
        """Clear tokens on refresh failure."""
        _clear_tokens(self.connection_name)
        _sessions.pop(self.connection_name, None)
        log.warning("Session expired for %r — user must re-login", self.connection_name)


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


def _write_tokens(connection_name: str, access_token: str, expires_at: float,
                   oidc_meta: dict | None = None):
    """Write access_token + expires_at to connections.json for a connection."""
    cfg = _load_config()
    for conn in cfg.get("connections", []):
        if conn.get("name") == connection_name:
            conn["tokens"] = {
                "access_token": access_token,
                "expires_at": int(expires_at),
            }
            if oidc_meta:
                conn["oidc"] = oidc_meta
            break
    _save_config(cfg)


def _clear_tokens(connection_name: str, clear_oidc: bool = False):
    """Remove tokens from connections.json for a connection."""
    cfg = _load_config()
    for conn in cfg.get("connections", []):
        if conn.get("name") == connection_name:
            conn.pop("tokens", None)
            if clear_oidc:
                conn.pop("oidc", None)
            break
    _save_config(cfg)


def _generate_pkce() -> tuple[str, str]:
    """Generate PKCE code_verifier and code_challenge (S256)."""
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    import base64
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def discover_auth_config(hugr_url: str, tls_skip_verify: bool = False) -> dict | None:
    """Fetch OIDC config from Hugr server's GET /auth/config endpoint.

    Returns {"issuer": "...", "client_id": "..."} or None if not configured.
    """
    base = hugr_url.rstrip("/")
    # Strip /ipc suffix if present to get the server base URL
    if base.endswith("/ipc"):
        base = base[:-4]

    try:
        with httpx.Client(timeout=5, verify=not tls_skip_verify) as client:
            resp = client.get(f"{base}/auth/config")
        if resp.status_code == 200:
            data = resp.json()
            if data.get("issuer"):
                return data
        return None
    except Exception as e:
        log.warning("Failed to discover auth config from %s: %s", base, e)
        return None


def _discover_oidc_endpoints(issuer: str, tls_skip_verify: bool = False) -> dict:
    """Fetch OIDC discovery document from issuer."""
    url = f"{issuer.rstrip('/')}/.well-known/openid-configuration"
    with httpx.Client(timeout=5, verify=not tls_skip_verify) as client:
        resp = client.get(url)
        resp.raise_for_status()
    return resp.json()


def start_login(connection_name: str, hugr_url: str, callback_base_url: str, tls_skip_verify: bool = False) -> str:
    """Start OIDC login flow. Returns the authorization URL to open in browser.

    Args:
        connection_name: Name of the connection in connections.json
        hugr_url: Hugr server URL (e.g., http://localhost:15004/ipc)
        callback_base_url: Base URL for callback (e.g., http://localhost:8888)

    Returns:
        Authorization URL to open in browser

    Raises:
        ValueError: If OIDC not configured or login already in progress
    """
    if connection_name in _sessions:
        # Already logged in — allow re-login (will replace session)
        pass

    # Clean up any existing pending login for this connection
    for state, pending in list(_pending.items()):
        if pending.connection_name == connection_name:
            _pending.pop(state, None)
            log.info("Cleared previous pending login for %r", connection_name)
            break

    # Discover OIDC config from Hugr server
    auth_config = discover_auth_config(hugr_url, tls_skip_verify=tls_skip_verify)
    if not auth_config:
        raise ValueError("OIDC not configured on this Hugr server")

    issuer = auth_config["issuer"]
    client_id = auth_config["client_id"]

    # Discover OIDC endpoints
    oidc_config = _discover_oidc_endpoints(issuer, tls_skip_verify=tls_skip_verify)
    authorization_endpoint = oidc_config["authorization_endpoint"]
    token_endpoint = oidc_config["token_endpoint"]

    # Generate PKCE
    code_verifier, code_challenge = _generate_pkce()

    # Generate state for CSRF protection
    state = secrets.token_urlsafe(32)

    # Build redirect URI
    redirect_uri = f"{callback_base_url.rstrip('/')}/hugr/oauth/callback"

    # Store pending login
    _pending[state] = PendingLogin(
        connection_name=connection_name,
        code_verifier=code_verifier,
        token_endpoint=token_endpoint,
        client_id=client_id,
        redirect_uri=redirect_uri,
        issuer=issuer,
        tls_skip_verify=tls_skip_verify,
    )

    # Build authorization URL
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": state,
        "scope": "openid",
    }
    auth_url = f"{authorization_endpoint}?{urlencode(params)}"
    log.info("Login started for %r, state=%s", connection_name, state[:8])
    return auth_url


def exchange_code(state: str, code: str) -> LoginSession:
    """Exchange authorization code for tokens after callback.

    Args:
        state: The state parameter from the callback
        code: The authorization code from the callback

    Returns:
        LoginSession with active refresh timer

    Raises:
        ValueError: If state is invalid or expired
    """
    pending = _pending.pop(state, None)
    if not pending:
        raise ValueError("Invalid or expired state parameter")

    if time.time() - pending.created_at > 120:
        raise ValueError("Login flow expired")

    # Exchange code for tokens
    with httpx.Client(timeout=10, verify=not pending.tls_skip_verify) as client:
        resp = client.post(pending.token_endpoint, data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": pending.redirect_uri,
            "client_id": pending.client_id,
            "code_verifier": pending.code_verifier,
        })

    if resp.status_code != 200:
        raise ValueError(f"Token exchange failed: {resp.text}")

    tokens = resp.json()
    access_token = tokens["access_token"]
    expires_at = time.time() + tokens.get("expires_in", 300)
    refresh_token = tokens.get("refresh_token", "")

    # Cancel previous session if exists
    old = _sessions.pop(pending.connection_name, None)
    if old:
        old.cancel_refresh_timer()

    # Write access token to file (skip for temp test connections)
    if not pending.connection_name.startswith("__test_"):
        _write_tokens(pending.connection_name, access_token, expires_at, oidc_meta={
            "issuer": pending.issuer,
            "client_id": pending.client_id,
            "token_endpoint": pending.token_endpoint,
        })

    # Create session
    session = LoginSession(
        connection_name=pending.connection_name,
        refresh_token=refresh_token,
        access_token=access_token,
        expires_at=expires_at,
        token_endpoint=pending.token_endpoint,
        client_id=pending.client_id,
        issuer=pending.issuer,
        tls_skip_verify=pending.tls_skip_verify,
    )
    _sessions[pending.connection_name] = session

    # Start refresh timer (skip for temp test connections)
    if refresh_token and not pending.connection_name.startswith("__test_"):
        session.start_refresh_timer()

    log.info("Login complete for %r, expires in %ds",
             pending.connection_name, tokens.get("expires_in", 300))
    return session


def get_session(connection_name: str) -> LoginSession | None:
    """Get active login session for a connection."""
    return _sessions.get(connection_name)


def get_token(connection_name: str) -> dict | None:
    """Get current access token for a connection.

    Forces refresh if token is near expiry (< 30s).
    Returns {"access_token": "...", "expires_at": N} or None.
    """
    session = _sessions.get(connection_name)
    if not session:
        return None

    # Force refresh if near expiry
    if session.expires_at - time.time() < 30 and session.refresh_token:
        session._do_refresh()
        # Re-check after refresh
        session = _sessions.get(connection_name)
        if not session:
            return None

    return {
        "access_token": session.access_token,
        "expires_at": int(session.expires_at),
    }


def logout(connection_name: str, post_logout_redirect: str = "") -> dict | None:
    """Clear tokens, stop refresh, and revoke session at IdP.

    Returns {"end_session_url": "..."} if IdP supports end_session_endpoint,
    so the frontend can redirect the user's browser to fully log out.
    """
    session = _sessions.pop(connection_name, None)
    end_session_url = None
    if session:
        session.cancel_refresh_timer()
        # Build end_session URL to clear IdP browser session
        if session.issuer:
            try:
                oidc_config = _discover_oidc_endpoints(session.issuer)
                end_session_ep = oidc_config.get("end_session_endpoint")
                if end_session_ep:
                    from urllib.parse import urlencode
                    params = {"client_id": session.client_id}
                    if post_logout_redirect:
                        params["post_logout_redirect_uri"] = post_logout_redirect
                    end_session_url = f"{end_session_ep}?{urlencode(params)}"
            except Exception as e:
                log.warning("Failed to discover end_session_endpoint for %r: %s",
                            connection_name, e)
    _clear_tokens(connection_name, clear_oidc=True)
    log.info("Logged out %r", connection_name)
    return {"end_session_url": end_session_url} if end_session_url else None


def is_authenticated(connection_name: str) -> dict:
    """Check authentication status for a connection."""
    session = _sessions.get(connection_name)
    if session and session.expires_at > time.time():
        return {
            "authenticated": True,
            "expires_at": int(session.expires_at),
            "auth_type": "browser",
        }
    return {
        "authenticated": False,
        "auth_type": "browser",
    }


def cleanup_expired_pending():
    """Remove pending logins older than 2 minutes."""
    now = time.time()
    expired = [s for s, p in _pending.items() if now - p.created_at > 120]
    for s in expired:
        _pending.pop(s, None)


def restore_sessions_on_startup() -> list[dict]:
    """Scan connections.json on startup for browser connections with valid tokens.

    After a service restart, refresh_token is lost. If access_token is still valid,
    mark the connection as authenticated (no refresh) so queries work until expiry.

    Returns list of connections that need re-login (expired token + oidc metadata).
    """
    cfg = _load_config()
    needs_relogin: list[dict] = []

    for conn in cfg.get("connections", []):
        if conn.get("auth_type") != "browser":
            continue

        oidc_meta = conn.get("oidc", {})
        tokens = conn.get("tokens")

        if not tokens or not tokens.get("access_token"):
            # No tokens but has oidc metadata — needs re-login
            if oidc_meta.get("issuer"):
                needs_relogin.append({"name": conn["name"], "url": conn.get("url", "")})
            continue

        expires_at = tokens.get("expires_at", 0)
        if expires_at <= time.time():
            # Token expired — needs re-login
            log.info("Token expired for %r on startup", conn["name"])
            conn.pop("tokens", None)
            if oidc_meta.get("issuer"):
                needs_relogin.append({"name": conn["name"], "url": conn.get("url", "")})
            continue

        # Token still valid but no refresh_token (lost on restart)
        issuer = oidc_meta.get("issuer", "")
        client_id = oidc_meta.get("client_id", "")
        token_endpoint = oidc_meta.get("token_endpoint", "")

        # Create a session without refresh capability
        session = LoginSession(
            connection_name=conn["name"],
            refresh_token="",  # lost on restart
            access_token=tokens["access_token"],
            expires_at=expires_at,
            token_endpoint=token_endpoint,
            client_id=client_id,
            issuer=issuer,
            tls_skip_verify=conn.get("tls_skip_verify", False),
        )
        _sessions[conn["name"]] = session
        log.info("Restored session for %r (no refresh, expires at %d)",
                 conn["name"], expires_at)

    # Save config with any cleared tokens
    _save_config(cfg)
    return needs_relogin


