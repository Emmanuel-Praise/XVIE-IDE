"""Zetaris live-data client for xvie-agent — read-only analytics gateway.

Zetaris (http://<host>:<port>, the IDE uses the local instance on port
3000) exposes the agent-facing surface we support through a small set of
UI-proxy routes:

* ``POST /api/auth/login``                         — username/password → idToken
* ``GET  /api/proxy/datasource/datasources``       — registered data sources
* ``POST /api/proxy/sql-editor/sqls/run-query``    — one-shot SQL → headers/data

Design rules (mirrors the platform's own conventions):

* **Read-only.** Only statements starting with SELECT/SHOW/DESCRIBE/DESC/
  EXPLAIN/WITH are accepted, and obvious write verbs anywhere in the
  statement are rejected.  Zetaris catalogs may sit on production data;
  the agent must never mutate it.
* **Never block core flows.** Every request has a short timeout and every
  failure surfaces as a string message — callers decide how to degrade.
* **Best shot token cache.** The idToken (~1 h JWT) is cached and reused;
  a 401 forces a single re-login and one retry.
* **Env driven.** Everything comes from variables prefixed ``ZETARIS_``
  (loaded from ``.env`` by ``config.load_config`` in the normal flow).

Supported environment variables::

    ZETARIS_BASE_URL=http://localhost:3000
    ZETARIS_USERNAME=admin@zetaris.com
    ZETARIS_PASSWORD=...
    ZETARIS_ORG_ID=            # optional; learned from login response
    ZETARIS_QUERY_LIMIT=200    # default row cap per query
    ZETARIS_TIMEOUT_SECONDS=30 # per-request timeout
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any

# --------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@dataclass
class ZetarisConfig:
    """Connection settings sourced from ``ZETARIS_*`` environment variables."""

    base_url: str = ""
    username: str = ""
    password: str = ""
    org_id: int | None = None
    query_limit: int = 200
    timeout_seconds: int = 30

    @property
    def is_configured(self) -> bool:
        return bool(self.base_url and self.username and self.password)


def load_config(env: dict[str, str] | None = None) -> ZetarisConfig:
    """Build a :class:`ZetarisConfig` from the environment (or a mapping)."""
    env = env if env is not None else dict(__import__("os").environ)

    base_url = (env.get("ZETARIS_BASE_URL") or "").rstrip("/")
    username = (env.get("ZETARIS_USERNAME") or env.get("ZETARIS_EMAIL") or "").strip()
    password = env.get("ZETARIS_PASSWORD") or ""
    try:
        org_id = int(env["ZETARIS_ORG_ID"]) if env.get("ZETARIS_ORG_ID") else None
    except ValueError:
        org_id = None
    try:
        query_limit = int(env.get("ZETARIS_QUERY_LIMIT") or 200)
    except ValueError:
        query_limit = 200
    if query_limit < 1:
        query_limit = 200
    try:
        timeout = int(env.get("ZETARIS_TIMEOUT_SECONDS") or 30)
    except ValueError:
        timeout = 30
    if timeout < 1:
        timeout = 30

    return ZetarisConfig(
        base_url=base_url,
        username=username,
        password=password,
        org_id=org_id,
        query_limit=query_limit,
        timeout_seconds=timeout,
    )


# ---------------------------------------------------------------------------
# Read-only SQL guard
# ---------------------------------------------------------------------------

_LEADING_KEYWORDS = re.compile(
    r"^\s*(?:--.*?\n|/\*.*?\*/|\n|\s)*\b(select|show|describe|desc|explain|with)\b",
    re.IGNORECASE,
)

_BANNED_VERBS = re.compile(
    r"\b(insert|update|delete|drop|alter|truncate|merge|replace|"
    r"grant|revoke|deny|load|export|copy|msck|remove|add\s+jar|reset)\b",
    re.IGNORECASE,
)


def assert_read_only(sql: str) -> str:
    """Validate *sql* as a read-only statement, else raise ``ValueError``."""
    stripped = (sql or "").strip()
    if not _LEADING_KEYWORDS.match(stripped):
        raise ValueError(
            "Only read-only SQL is allowed (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH)."
        )
    if _BANNED_VERBS.search(stripped):
        raise ValueError(
            "Write statements are blocked: Zetaris tools run against "
            "production data and must remain read-only."
        )
    return stripped


# ---------------------------------------------------------------------------
# Query result
# ---------------------------------------------------------------------------


@dataclass
class ZetarisQueryResult:
    """Parsed ``run-query`` response (``headers``/``data``/``total``/``timeUsed``)."""

    headers: list[str] = field(default_factory=list)
    data: list[list[Any]] = field(default_factory=list)
    total: int = 0
    time_used_ms: int = 0

    def format(self, max_rows: int, max_chars: int) -> str:
        """Render as a compact table for the agent's tool-output budget."""
        rows = self.data[:max_rows]
        widths = [len(h) for h in self.headers]
        for row in rows:
            for i, cell in enumerate(row[: len(widths)]):
                widths[i] = min(widths[i], 40) or min(40, max(widths[i], len(str(cell))))
        widths = [min(w, 40) for w in widths]

        def _fmt(row: list[Any]) -> str:
            cells = []
            for i, cell in enumerate(row[: len(widths)]):
                text = str(cell) if cell is not None else "NULL"
                cells.append(text[: widths[i]].ljust(widths[i]))
            return " | ".join(cells)

        lines = [" | ".join(h.ljust(w) for h, w in zip(self.headers, widths))]
        lines.append("-+-".join("-" * w for w in widths))
        lines.extend(_fmt(row) for row in rows)
        body = "\n".join(lines)
        truncated_chars = False
        if len(body) > max_chars:
            body = body[:max_chars]
            truncated_chars = True
        suffix = ""
        if self.total > max_rows or truncated_chars or len(self.data) > max_rows:
            suffix = (
                f"\n(showing {min(max_rows, len(self.data))} of {self.total} rows, "
                f"{self.time_used_ms} ms — refine the SQL or raise the limit if needed)"
            )
        return body + suffix


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class ZetarisError(RuntimeError):
    """Raised (and also used as the message text) for expected Zetaris failures."""


class ZetarisClient:
    """Minimal authenticated client for the Zetaris UI-proxy API.

    Uses ``urllib`` so the module mirrors the in-repo HTTP-tool style and
    keeps the agent dependency-free here.  Token caching is process-wide
    per instance; ``threading.Lock`` guards concurrent logins.
    """

    def __init__(self, config: ZetarisConfig) -> None:
        self._config = config
        self._token: str | None = None
        self._org_id: int | None = config.org_id
        self._token_acquired_at: float = 0.0
        self._lock = threading.Lock()

    # -- low-level helpers ---------------------------------------------------

    def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: dict[str, Any] | None = None,
        token: str | None = None,
    ) -> Any:
        headers: dict[str, str] = {
            "X-Request-ID": str(uuid.uuid4()),
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if self._org_id is not None and "login" not in path:
            headers["X-Org-ID"] = str(self._org_id)
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")

        request = urllib.request.Request(
            f"{self._config.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self._config.timeout_seconds) as resp:
                payload = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read(500).decode("utf-8", errors="replace")
            except Exception:  # pragma: no cover - body already consumed
                pass
            raise ZetarisError(f"HTTP {exc.code} from {path}: {detail or exc.reason}") from exc
        except (OSError, TimeoutError) as exc:
            raise ZetarisError(f"Cannot reach Zetaris at {self._config.base_url}: {exc}") from exc

        if not payload:
            return None
        try:
            return json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ZetarisError(f"Zetaris returned non-JSON for {path}") from exc

    def _login(self) -> str:
        payload = self._request(
            "/api/auth/login",
            method="POST",
            body={"username": self._config.username, "password": self._config.password},
        )
        token = None
        if isinstance(payload, dict):
            token = payload.get("idToken") or payload.get("token") or payload.get("accessToken")
            if self._org_id is None and isinstance(payload.get("orgId"), int):
                self._org_id = payload["orgId"]
        if not token:
            raise ZetarisError("Zetaris login did not return an access token.")
        return token

    def _auth(self) -> tuple[str, int]:
        """Return ``(bearer_token, org_id)``, logging in if needed (cached ~50 min)."""
        with self._lock:
            fresh = time.monotonic() - self._token_acquired_at < 50 * 60
            if self._token and fresh and self._org_id is not None:
                return self._token, self._org_id
            token = self._login()
            if self._org_id is None:
                raise ZetarisError(
                    "Zetaris login succeeded but no X-Org-ID is known; "
                    "set ZETARIS_ORG_ID in the environment."
                )
            self._token = token
            self._token_acquired_at = time.monotonic()
            return token, self._org_id

    def _proxy_request(self, path: str, *, method: str = "GET", body: dict | None = None) -> Any:
        token, _ = self._auth()
        try:
            return self._request(path, method=method, body=body, token=token)
        except ZetarisError as exc:
            if "HTTP 401" not in str(exc):
                raise
            # Stale token: force one re-login and retry once.
            with self._lock:
                self._token = None
                self._token_acquired_at = 0.0
            token, _ = self._auth()
            return self._request(path, method=method, body=body, token=token)

    # -- public surface --------------------------------------------------------

    def run_query(self, sql: str, *, limit: int | None = None) -> ZetarisQueryResult:
        """Run one read-only SQL statement via the SQL-editor proxy route."""
        sql = assert_read_only(sql)
        row_limit = limit if limit and limit > 0 else self._config.query_limit
        payload = self._proxy_request(
            "/api/proxy/sql-editor/sqls/run-query",
            method="POST",
            body={"sql": sql, "limit": row_limit},
        )
        if not isinstance(payload, dict):
            raise ZetarisError("Unexpected Zetaris run-query response.")
        result = ZetarisQueryResult(
            headers=[str(h) for h in (payload.get("headers") or [])],
            data=list(payload.get("data") or []),
            total=int(payload.get("total") or len(payload.get("data") or [])),
            time_used_ms=int(payload.get("timeUsed") or 0),
        )
        if payload.get("msg"):
            # Some errors come back as 200 with a message payload.
            raise ZetarisError(str(payload["msg"]))
        return result

    def list_datasources(self) -> list[dict[str, Any]]:
        """List registered Zetaris data sources (name, type, table count)."""
        payload = self._proxy_request("/api/proxy/datasource/datasources", method="GET")
        if not isinstance(payload, list):
            raise ZetarisError("Unexpected datasources response.")
        return payload

    def list_tables(self, catalog: str) -> list[dict[str, Any]]:
        """List tables registered under a catalog via ``SHOW TABLES IN ...``."""
        result = self.run_query(f"SHOW TABLES IN {catalog}")
        return [
            {"table": row[0] if row else "", "catalog": row[1] if len(row) > 1 else "", "type": row[2] if len(row) > 2 else ""}
            for row in result.data
        ]

    def describe_table(self, catalog: str, table: str) -> ZetarisQueryResult:
        """Column metadata for ``catalog.table`` via ``DESCRIBE``."""
        return self.run_query(f"DESCRIBE {catalog}.{table}")


# ---------------------------------------------------------------------------
# Module-level singleton plumbing (matches the config.py lazy pattern)
# ---------------------------------------------------------------------------

_default_client: ZetarisClient | None = None
_default_checked = False


def default_client() -> ZetarisClient | None:
    """Return a client for the ambient configuration, or ``None`` if unconfigured.

    The result is memoised so the per-call env scan is cheap; call
    :func:`reset_default_client` after config changes (mainly for tests).
    """
    global _default_client, _default_checked
    if not _default_checked:
        _default_checked = True
        cfg = load_config()
        if cfg.is_configured:
            _default_client = ZetarisClient(cfg)
    return _default_client


def reset_default_client() -> None:
    """Forget the memoised client (used after env changes or in tests)."""
    global _default_client, _default_checked
    _default_client = None
    _default_checked = False
