"""Tests for the Zetaris integration — client, guard, tools, registry.

Network tests run against a local stub server that mimics the two
Zetaris UI-proxy routes we use (``/api/auth/login`` and
``/api/proxy/sql-editor/sqls/run-query``); nothing here talks to the
real Zetaris instance so the suite stays hermetic.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from xvie_agent import tools as tools_mod
from xvie_agent import zetaris
from xvie_agent.zetaris import (
    ZetarisClient,
    ZetarisConfig,
    ZetarisQueryResult,
    ZetarisError,
    assert_read_only,
    load_config,
    reset_default_client,
)


# ---------------------------------------------------------------------------
# Read-only guard
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("sql", [
    "SELECT 1",
    "select * from COMMUNITY_WATCH.reports limit 10",
    "SHOW TABLES IN community_watch",
    "DESCRIBE community_watch.reports",
    "DESC community_watch.reports",
    "EXPLAIN SELECT 1",
    "WITH totals AS (SELECT 1 AS n) SELECT * FROM totals",
    "-- gather counts\nSELECT COUNT(*) FROM t",
    "/* block */ SELECT 1",
])
def test_read_only_allows_reads(sql):
    assert assert_read_only(sql)


@pytest.mark.parametrize("sql", [
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET x = 1",
    "DELETE FROM t",
    "DROP TABLE t",
    "ALTER TABLE t ADD COLUMN x INT",
    "TRUNCATE TABLE t",
    "MERGE INTO t USING s ON 1=1",
    "CREATE TABLE t (x INT)",
    "GRANT SELECT ON t TO u",
    "SET spark.sql.shuffle.partitions=10",
    "LOAD DATA INPATH 'x' INTO TABLE t",
])
def test_read_only_blocks_writes(sql):
    with pytest.raises(ValueError):
        assert_read_only(sql)




def test_read_only_allows_column_named_like_write_verb():
    # \b word boundary — 'updated_at' is a column, not the UPDATE verb.
    assert assert_read_only("SELECT updated_at, deleted_mark FROM t")


def test_read_only_blocks_write_verb_inside_with():
    with pytest.raises(ValueError):
        assert_read_only("WITH w AS (SELECT 1) DELETE FROM t")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def test_load_config_from_mapping():
    cfg = load_config({
        "ZETARIS_BASE_URL": "http://localhost:3000/",
        "ZETARIS_USERNAME": "u",
        "ZETARIS_PASSWORD": "p",
        "ZETARIS_ORG_ID": "7",
        "ZETARIS_QUERY_LIMIT": "42",
    })
    assert cfg.base_url == "http://localhost:3000"  # trailing slash stripped
    assert cfg.org_id == 7
    assert cfg.query_limit == 42
    assert cfg.is_configured


def test_load_config_incomplete_is_unconfigured():
    assert not load_config({"ZETARIS_BASE_URL": "http://x"}).is_configured
    assert not load_config({}).is_configured


def test_load_config_bad_values_fall_back_to_defaults():
    cfg = load_config({
        "ZETARIS_BASE_URL": "http://x",
        "ZETARIS_USERNAME": "u",
        "ZETARIS_PASSWORD": "p",
        "ZETARIS_ORG_ID": "not-a-number",
        "ZETARIS_QUERY_LIMIT": "-1",
        "ZETARIS_TIMEOUT_SECONDS": "bogus",
    })
    assert cfg.org_id is None
    assert cfg.query_limit == 200
    assert cfg.timeout_seconds == 30


# ---------------------------------------------------------------------------
# Result formatting
# ---------------------------------------------------------------------------


def _result(total=3, rows=None, time_used=120):
    return ZetarisQueryResult(
        headers=["name", "count"],
        data=rows if rows is not None else [["a", 1], ["b", 2]],
        total=total,
        time_used_ms=time_used,
    )


def test_format_renders_table_and_suffix():
    text = _result(total=5).format(max_rows=3, max_chars=2000)
    assert "name" in text and "count" in text
    assert "a" in text and "2" in text
    suffix = text.split("\n(showing ", 1)[1]
    assert suffix.startswith("2 of 5 rows")
    assert "120 ms" in text


def test_format_omits_suffix_when_showing_everything():
    text = _result().format(max_rows=3, max_chars=2000)
    assert "(showing" not in text


def test_format_truncates_long_output():
    rows = [["r" * 100, 1]] * 50
    text = _result(total=50, rows=rows).format(max_rows=30, max_chars=300)
    assert len(text) <= 300 + 120  # truncated body + suffix
    assert "refine the SQL" in text


def test_format_handles_null_cells():
    text = _result(rows=[[None, 5]]).format(max_rows=2, max_chars=2000)
    assert "NULL" in text


# ---------------------------------------------------------------------------
# Client against a stub Zetaris server
# ---------------------------------------------------------------------------


class _StubZetaris(BaseHTTPRequestHandler):
    """Bytes-level stand-in for the UI proxy: login + run-query (+ 401 once)."""

    fail_auth_once = False
    requests: list[dict] = []
    tokens_issued = 0

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _record(self, body=None):
        _StubZetaris.requests.append({
            "path": self.path,
            "method": self.command,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": body,
        })

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode() if length else ""
        self._record(json.loads(raw) if raw else None)
        if self.path == "/api/auth/login":
            _StubZetaris.tokens_issued += 1
            self._json({
                "idToken": f"test-token-{_StubZetaris.tokens_issued}",
                "refreshToken": "r",
                "orgId": 7,
            })
        elif self.path == "/api/proxy/sql-editor/sqls/run-query":
            if _StubZetaris.fail_auth_once:
                _StubZetaris.fail_auth_once = False
                self._json({"msg": "stale token"}, status=401)
                return
            auth = self.headers.get("Authorization") or ""
            if not auth.startswith("Bearer test-token-"):
                self._json({"msg": "invalid token"}, status=401)
                return
            self._json({"headers": ["n"], "data": [[1]], "total": 1, "timeUsed": 5})
        else:
            self._json({"msg": "unknown route"}, status=404)

    def do_GET(self):
        self._record()
        if self.path.startswith("/api/proxy/datasource/datasources"):
            self._json([{"dataSourceId": 1, "name": "community_watch", "tableCount": 2}])
        else:
            self._json({"msg": "unknown route"}, status=404)

    def log_message(self, *args):  # silence test output
        pass


@pytest.fixture()
def stub_server(monkeypatch):
    for key in ("ZETARIS_BASE_URL", "ZETARIS_USERNAME", "ZETARIS_PASSWORD",
                "ZETARIS_ORG_ID", "ZETARIS_QUERY_LIMIT", "ZETARIS_TIMEOUT_SECONDS"):
        monkeypatch.delenv(key, raising=False)
    reset_default_client()
    _StubZetaris.requests = []
    _StubZetaris.fail_auth_once = False
    _StubZetaris.tokens_issued = 0
    server = ThreadingHTTPServer(("127.0.0.1", 0), _StubZetaris)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    config = ZetarisConfig(
        base_url=f"http://127.0.0.1:{server.server_port}",
        username="u", password="p", org_id=None,
    )
    yield config
    server.shutdown()
    server.server_close()
    reset_default_client()


def make_client(stub_server):
    return ZetarisClient(stub_server)


def test_client_login_caches_and_sets_org(stub_server):
    client = make_client(stub_server)
    result = client.run_query("SELECT 1")
    assert result.headers == ["n"]
    assert result.data == [[1]]
    logins = [r for r in _StubZetaris.requests if r["path"] == "/api/auth/login"]
    queries = [r for r in _StubZetaris.requests if "run-query" in r["path"]]
    assert len(logins) == 1           # token cached between calls
    client.run_query("SELECT 2")
    assert len([r for r in _StubZetaris.requests if r["path"] == "/api/auth/login"]) == 1
    assert queries and queries[0]["headers"]["x-org-id"] == "7"  # learned from login
    assert queries[0]["body"] == {"sql": "SELECT 1", "limit": 200}
    assert queries[0]["headers"]["x-request-id"]


def test_client_sends_bearer_token(stub_server):
    client = make_client(stub_server)
    client.run_query("SELECT 1")
    q = next(r for r in _StubZetaris.requests if "run-query" in r["path"])
    assert q["headers"]["authorization"].startswith("Bearer test-token-")


def test_client_blocks_writes(stub_server):
    client = make_client(stub_server)
    with pytest.raises(ValueError):
        client.run_query("DELETE FROM t")
    assert _StubZetaris.requests == []  # nothing ever left the process


def test_client_custom_limit(stub_server):
    client = make_client(stub_server)
    client.run_query("SELECT 1", limit=5)
    q = next(r for r in _StubZetaris.requests if "run-query" in r["path"])
    assert q["body"] == {"sql": "SELECT 1", "limit": 5}


def test_client_retries_once_on_401(stub_server):
    client = make_client(stub_server)
    client.run_query("SELECT 1")  # warms the cache with test-token-1
    logins_before = len([r for r in _StubZetaris.requests if r["path"] == "/api/auth/login"])
    _StubZetaris.fail_auth_once = True  # next run-query returns 401 once
    result = client.run_query("SELECT 3")
    assert result.data == [[1]]  # the retried request succeeded
    logins_after = len([r for r in _StubZetaris.requests if r["path"] == "/api/auth/login"])
    assert logins_after == logins_before + 1  # exactly one forced re-login


def test_client_list_datasources(stub_server):
    client = make_client(stub_server)
    sources = client.list_datasources()
    assert sources[0]["name"] == "community_watch"


def test_client_list_tables_uses_show_tables(stub_server, monkeypatch):
    captured = {}

    def fake_proxy(self, path, method="GET", body=None):
        captured["sql"] = body["sql"]
        return {"headers": ["table_identifier"], "data": [["X.t"]], "total": 1, "timeUsed": 1}

    monkeypatch.setattr(ZetarisClient, "_proxy_request", fake_proxy)
    client = make_client(stub_server)
    assert client.list_tables("x")[0]["table"] == "X.t"
    assert captured["sql"] == "SHOW TABLES IN x"


def test_client_describe_table(stub_server, monkeypatch):
    captured = {}

    def fake_proxy(self, path, method="GET", body=None):
        captured["sql"] = body["sql"]
        return {"headers": ["c"], "data": [["id"]], "total": 1, "timeUsed": 1}

    monkeypatch.setattr(ZetarisClient, "_proxy_request", fake_proxy)
    client = make_client(stub_server)
    assert client.describe_table("x", "y").data == [["id"]]
    assert captured["sql"] == "DESCRIBE x.y"


def test_default_client_reads_env_and_memoises(monkeypatch):
    monkeypatch.setenv("ZETARIS_BASE_URL", "http://localhost:3000")
    monkeypatch.setenv("ZETARIS_USERNAME", "u")
    monkeypatch.setenv("ZETARIS_PASSWORD", "p")
    monkeypatch.setenv("ZETARIS_ORG_ID", "1")
    reset_default_client()
    try:
        first = zetaris.default_client()
        second = zetaris.default_client()
        assert first is not None
        assert first is second
    finally:
        reset_default_client()


def test_default_client_none_when_unconfigured(monkeypatch):
    for key in ("ZETARIS_BASE_URL", "ZETARIS_USERNAME", "ZETARIS_PASSWORD"):
        monkeypatch.delenv(key, raising=False)
    reset_default_client()
    assert zetaris.default_client() is None


# ---------------------------------------------------------------------------
# Tool handlers + registry wiring
# ---------------------------------------------------------------------------


class _FakeClient:
    """Duck-typed ZetarisClient for handler tests."""

    def __init__(self, result=None, sources=None, to_raise=None):
        self._result = result
        self._sources = sources
        self._raise = to_raise

    def run_query(self, sql, *, limit=None):
        if self._raise:
            raise self._raise
        return self._result

    def list_datasources(self):
        return self._sources

    def list_tables(self, catalog):
        if self._raise:
            raise self._raise
        return [{"table": f"{catalog}.t1", "catalog": catalog.upper(), "type": "Data Source"}]

    def describe_table(self, catalog, table):
        if self._raise:
            raise self._raise
        return ZetarisQueryResult(headers=["col", "type"], data=[["id", "int"]], total=1, time_used_ms=2)


def _ctx():
    return tools_mod.ToolContext(workspace_root=__import__("pathlib").Path("."))


@pytest.fixture()
def fake_client(monkeypatch):
    client = _FakeClient(result=_result(), sources=[{"name": "comm", "tableCount": 2}])
    monkeypatch.setattr(zetaris, "default_client", lambda: client)
    return client


def test_tool_zetaris_query_returns_rows(fake_client, monkeypatch):
    # default_client is resolved lazily inside the handler via the module
    out = tools_mod._zetaris_query({"sql": "SELECT 1"}, _ctx())
    assert out.ok and "name" in out.content


def test_tool_zetaris_query_read_only_guard(fake_client):
    fake_client._raise = ValueError("writes blocked")
    out = tools_mod._zetaris_query({"sql": "DROP TABLE t"}, _ctx())
    assert not out.ok and out.error_kind == "read_only_guard"
    # Guard may reject before ever reaching the client; content still surfaces.


def test_tool_zetaris_query_error_surfaces(fake_client):
    fake_client._raise = ZetarisError("boom")
    out = tools_mod._zetaris_query({"sql": "SELECT 1"}, _ctx())
    assert not out.ok and out.error_kind == "zetaris_error"
    assert "boom" in out.content


def test_tool_zetaris_query_requires_config(monkeypatch):
    monkeypatch.setattr(zetaris, "default_client", lambda: None)
    out = tools_mod._zetaris_query({"sql": "SELECT 1"}, _ctx())
    assert not out.ok and out.error_kind == "not_configured"
    assert "ZETARIS_BASE_URL" in out.content


def test_tool_zetaris_catalog_datasources(fake_client):
    out = tools_mod._zetaris_catalog({"kind": "datasources"}, _ctx())
    assert out.ok and "comm" in out.content


def test_tool_zetaris_catalog_tables(fake_client):
    out = tools_mod._zetaris_catalog({"kind": "tables", "catalog": "COMM"}, _ctx())
    assert out.ok and "COMM.t1" in out.content


def test_tool_zetaris_catalog_columns(fake_client):
    out = tools_mod._zetaris_catalog({"kind": "columns", "catalog": "comm", "table": "t1"}, _ctx())
    assert out.ok and "id" in out.content


def test_tool_zetaris_catalog_requires_args(fake_client):
    out = tools_mod._zetaris_catalog({"kind": "columns"}, _ctx())
    assert not out.ok and out.error_kind == "missing_argument"
    out = tools_mod._zetaris_catalog({"kind": "nope"}, _ctx())
    assert not out.ok


def test_registry_includes_zetaris_when_configured(monkeypatch):
    monkeypatch.setattr(zetaris, "default_client", lambda: _FakeClient())
    registry = tools_mod.build_default_registry(_ctx())
    assert "zetaris_query" in registry
    assert "zetaris_catalog" in registry
    assert "zetaris" in registry["zetaris_query"].description.lower()
    assert registry["zetaris_query"].json_schema["required"] == ["sql"]


def test_registry_skips_zetaris_when_unconfigured(monkeypatch):
    monkeypatch.setattr(zetaris, "default_client", lambda: None)
    registry = tools_mod.build_default_registry(_ctx())
    assert "zetaris_query" not in registry
    assert "zetaris_catalog" not in registry
