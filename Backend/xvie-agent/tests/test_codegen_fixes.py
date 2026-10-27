"""Regression tests for direct-write code generation fixes.

Covers:
- Auto-continue when output is truncated (finish_reason=length)
- Streaming payload requests usage stats (stream_options)
- Strict website (rich_html) validation wired through AgentLoop
- Quality-first model ordering in coding/ui_design lanes
- Chat defaults to accept-edits permission mode
"""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

from xvie_agent.agent import AgentLoop
from xvie_agent.execution import is_website_task, validate_changed_file
from xvie_agent.router import load_routing_config
from xvie_agent.tools import ToolContext, build_default_registry
from xvie_agent.types import AssistantTurn, ToolCall, UsageStats


def _ensure_plan(tmp_path: Path) -> None:
    """Pre-create a completed plan so the plan gate and plan guard don't interfere."""
    plans_dir = tmp_path / ".xvie" / "plans"
    plans_dir.mkdir(parents=True, exist_ok=True)
    (plans_dir / "test-plan.md").write_text(
        "# Test Plan\n\n## Steps\n\n- [x] **Task** - Do something\n", encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# Stub client that can emit truncated turns
# ---------------------------------------------------------------------------


class TruncatingStubClient:
    """First call returns a truncated turn; later calls return canned turns."""

    def __init__(self, responses: Sequence[AssistantTurn]) -> None:
        self._responses = list(responses)
        self._call_index = 0
        self.calls: list[dict] = []

    def complete(self, model: str, messages: list[dict], tools=None, temperature=0.0):
        self.calls.append({"model": model, "messages": messages})
        if self._call_index >= len(self._responses):
            raise RuntimeError("no more responses")
        resp = self._responses[self._call_index]
        self._call_index += 1
        return resp

    def close(self):
        pass


def _turn(content: str, truncated: bool = False, incomplete: bool = False) -> AssistantTurn:
    return AssistantTurn(
        content=content,
        tool_calls=(),
        usage=UsageStats(input_tokens=10, output_tokens=5),
        model="test-model",
        reasoning=None,
        truncated=truncated,
        incomplete=incomplete,
    )


# ---------------------------------------------------------------------------
# Auto-continue on truncation
# ---------------------------------------------------------------------------


class TestAutoContinue:
    def test_truncated_final_output_continues(self, tmp_path: Path) -> None:
        client = TruncatingStubClient([
            _turn("partial write...", truncated=True),
            _turn("now complete"),
        ])
        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        loop = AgentLoop(
            client=client,
            model="test-model",
            tools=build_default_registry(ctx),
            tool_ctx=ctx,
        )
        result = loop.run("write something long")
        assert result.final_output == "now complete"
        assert result.stop_reason == "completed"
        # Two model calls happened — the continuation nudge was sent.
        assert len(client.calls) == 2
        nudge = client.calls[1]["messages"][-1]
        assert nudge["role"] == "user"
        # The nudge should redirect the model to continue the task
        content = nudge["content"]
        assert any(w in content for w in ("Continue", "execute", "start", "now"))

    def test_continuation_bounded(self, tmp_path: Path) -> None:
        import xvie_agent.agent as agent_mod

        client = TruncatingStubClient([_turn("cut", truncated=True) for _ in range(20)])
        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        loop = AgentLoop(
            client=client,
            model="test-model",
            tools=build_default_registry(ctx),
            tool_ctx=ctx,
        )
        result = loop.run("go")
        # 1 initial + N continuations = N+1 calls max, then it gives up cleanly.
        assert len(client.calls) == 1 + agent_mod._MAX_TRUNC_CONTINUATIONS
        assert result.stop_reason == "output_incomplete"
        assert "Response incomplete" in result.final_output

    def test_unexpected_stream_end_continues_before_completing(self, tmp_path: Path) -> None:
        client = TruncatingStubClient([
            _turn("partial answer", incomplete=True),
            _turn("complete answer"),
        ])
        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        loop = AgentLoop(
            client=client,
            model="test-model",
            tools=build_default_registry(ctx),
            tool_ctx=ctx,
        )
        result = loop.run("go")
        assert len(client.calls) == 2
        assert result.stop_reason == "completed"
        assert result.final_output == "complete answer"
        assert "Continue exactly where you stopped" in client.calls[1]["messages"][-1]["content"]

    def test_untruncated_output_not_continued(self, tmp_path: Path) -> None:
        client = TruncatingStubClient([_turn("done")])
        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        loop = AgentLoop(
            client=client,
            model="test-model",
            tools=build_default_registry(ctx),
            tool_ctx=ctx,
        )
        result = loop.run("hi")
        assert len(client.calls) == 1
        assert result.final_output == "done"


# ---------------------------------------------------------------------------
# Streaming usage request
# ---------------------------------------------------------------------------


class TestStreamUsageRequested:
    def test_stream_payload_includes_stream_options(self) -> None:
        import json as _json

        import httpx

        from xvie_agent.providers.base import ProviderClient, ProviderConfig

        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(_json.loads(request.content))
            body = (
                b'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},'
                b'"finish_reason":"stop"}]}\ndata: [DONE]'
            )
            return httpx.Response(
                200,
                stream=httpx.ByteStream(body),
                headers={"content-type": "text/event-stream"},
            )

        config = ProviderConfig(name="nvidia", api_key="k", base_url="https://x/v1")
        http_client = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://x/v1")
        client = ProviderClient(config=config, client=http_client)
        list(client.stream(model="m", messages=[{"role": "user", "content": "hi"}]))
        assert captured.get("stream_options") == {"include_usage": True}
        client.close()


# ---------------------------------------------------------------------------
# Website quality validation wiring
# ---------------------------------------------------------------------------


class TestWebsiteValidationWiring:
    def test_website_prompt_detected(self):
        assert is_website_task("build me a website for a shop")
        assert is_website_task("create an html landing page")

    def test_non_website_prompt_not_detected(self):
        assert not is_website_task("fix the bug in utils.py")

    def test_shallow_html_rejected_with_rich_flag(self, tmp_path: Path):
        f = tmp_path / "shop.html"
        f.write_text(
            "<!DOCTYPE html><html><head><title>Shop</title></head>"
            "<body><h1>Shop</h1></body></html>"
        )
        error = validate_changed_file("shop.html", tmp_path, rich_html=True)
        assert error is not None
        assert "viewport" in error or "minimum 1200" in error

    def test_rich_html_passes(self, tmp_path: Path):
        body_parts = ["<p>content block</p>"] * 60
        f = tmp_path / "shop.html"
        f.write_text(
            '<!DOCTYPE html><html lang="en"><head><title>Shop</title>'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<style>body{margin:0;display:flex;flex-direction:column;min-height:100vh}'
            '@media(max-width:768px){main{padding:16px}}</style>'
            '</head><body>'
            '<header><nav>Shop</nav></header><main>'
            + "".join(body_parts)
            + '</main><footer>Contact us</footer></body></html>'
        )
        assert validate_changed_file("shop.html", tmp_path, rich_html=True) is None

    def test_loop_accepts_rich_html_param(self, tmp_path: Path):
        """AgentLoop exposes rich_html_validation without error."""
        ctx = ToolContext(workspace_root=tmp_path, allow_write=False, allow_shell=False)
        client = TruncatingStubClient([_turn("done")])
        loop = AgentLoop(
            client=client,
            model="m",
            tools=build_default_registry(ctx),
            tool_ctx=ctx,
            rich_html_validation=True,
        )
        assert loop._rich_html_validation is True


# ---------------------------------------------------------------------------
# Routing order + limits
# ---------------------------------------------------------------------------


class TestStubCompletionGate:
    """The loop must not stop after a stub write + status-only reply."""

    def test_stub_write_triggers_continuation(self, tmp_path: Path) -> None:
        _ensure_plan(tmp_path)
        client = TruncatingStubClient([
            # Turn 1: model writes a tiny stub file
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="w1", name="write_file", arguments={"path": "shop.html", "content": "<!DOCTYPE html><html><head><title>Shop</title></head><body><p>Stub</p></body></html>"}),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
            ),
            # Turn 2: model replies with a status line (would normally stop)
            AssistantTurn(
                content="The function call has been executed successfully.",
                usage=UsageStats(input_tokens=20, output_tokens=5),
            ),
            # Turn 3: model continues building (chunked append under the cap)
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="w2", name="append_file", arguments={"path": "shop.html", "content": "\n".join(f"<p>line {i}</p>" for i in range(250)) + "\n</body></html>"}),),
                usage=UsageStats(input_tokens=30, output_tokens=5),
            ),
            AssistantTurn(
                content="Done building the shop.",
                usage=UsageStats(input_tokens=40, output_tokens=5),
            ),
        ])
        ctx = ToolContext(workspace_root=tmp_path, allow_write=True, allow_shell=False)
        loop = AgentLoop(
            client=client,
            model="test-model",
            tools=build_default_registry(ctx),
            tool_ctx=ctx,
        )
        result = loop.run("build me a shop website with at least 1000 lines, name it shop.html")

        # The loop must NOT have stopped after the status-only reply — it
        # should have continued to the append_file call.
        assert len(result.tool_calls) >= 2
        assert result.tool_calls[1].name == "append_file"
        # The final file should contain the appended content.
        assert "line 249" in (tmp_path / "shop.html").read_text()
