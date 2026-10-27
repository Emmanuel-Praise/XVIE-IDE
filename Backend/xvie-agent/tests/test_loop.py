"""Tests for xvie_agent.loop — fake client, zero network access."""

from __future__ import annotations

from pathlib import Path

import pytest

from xvie_agent.loop import run_agent
from xvie_agent.session import SessionState
from xvie_agent.store import load_session
from xvie_agent.providers.base import PayloadTooLargeError
from xvie_agent.types import (
    AgentRunResult,
    AssistantTurn,
    BudgetConfig,
    ToolCall,
    UsageStats,
)


# ---------------------------------------------------------------------------
# Fake ProviderClient — scripted responses
# ---------------------------------------------------------------------------

class FakeClient:
    """Returns pre-configured responses, records all calls."""

    def __init__(self, responses: list[AssistantTurn]) -> None:
        self._responses = list(responses)
        self._idx = 0
        self.calls: list[dict] = []

    @property
    def provider_name(self) -> str:
        return "fake-provider"

    def complete(self, model, messages, tools=None, temperature=0.0, max_tokens=None):
        self.calls.append({"model": model, "messages": messages, "tools": tools})
        if self._idx >= len(self._responses):
            raise RuntimeError("FakeClient: exhausted responses")
        resp = self._responses[self._idx]
        self._idx += 1
        return resp

    def close(self):
        pass


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def sandbox(tmp_path: Path) -> Path:
    (tmp_path / "math_utils.py").write_text("def add(a, b):\n    return a + b\n")
    (tmp_path / "README.md").write_text("# Test Project\n")
    return tmp_path


# ---------------------------------------------------------------------------
# Tests — simple text response (no tools)
# ---------------------------------------------------------------------------

class TestRunAgentTextOnly:
    def test_simple_answer(self, sandbox: Path) -> None:
        fake = FakeClient([
            AssistantTurn(
                content="The add function returns the sum of a and b.",
                usage=UsageStats(input_tokens=20, output_tokens=10),
                model="test-model",
            ),
        ])
        result = run_agent(
            prompt="What does add do?",
            model="test-model",
            workspace_root=sandbox,
            provider=fake,
        )
        assert result.stop_reason == "completed"
        assert "add function" in result.final_output
        assert result.turns == 1
        assert result.usage.input_tokens == 20
        assert result.timings["provider_seconds"] > 0
        assert result.timings["context_prep_seconds"] >= 0


def test_payload_rejection_starts_one_linked_fresh_session(sandbox: Path, tmp_path: Path) -> None:
    class PayloadThenSuccess:
        provider_name = "test-provider"

        def __init__(self) -> None:
            self.calls = 0

        def complete(self, **kwargs):
            self.calls += 1
            if self.calls <= 2:
                raise PayloadTooLargeError("request too large", status_code=400, body="")
            return AssistantTurn(content="Continued successfully", model="test-model")

    client = PayloadThenSuccess()
    previous = SessionState(system_prompt="System")
    previous.append_user("Earlier task context")
    previous.append_assistant("Already completed inspection")

    result = run_agent(
        prompt="Continue the implementation",
        model="test-model",
        workspace_root=sandbox,
        provider=client,
        existing_session=previous,
        sessions_dir=tmp_path / "sessions",
    )

    linked = load_session(result.session_id, tmp_path / "sessions")
    prior = load_session(previous.session_id, tmp_path / "sessions")
    assert client.calls == 3
    assert result.stop_reason == "completed"
    assert f"linked session {result.session_id}" in result.final_output
    assert linked.parent_session_id == previous.session_id
    assert "Earlier task context" in linked.context_summary
    assert prior.execution_state["final_outcome"] == "payload_too_large"


# ---------------------------------------------------------------------------
# Tests — tool call round-trip
# ---------------------------------------------------------------------------

class TestRunAgentToolCalls:
    def test_single_tool_call(self, sandbox: Path) -> None:
        """Model reads a file, then gives a final answer."""
        fake = FakeClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="read_file", arguments={"path": "math_utils.py"}),),
                usage=UsageStats(input_tokens=30, output_tokens=5),
                model="test-model",
            ),
            AssistantTurn(
                content="The add function takes two arguments and returns their sum.",
                usage=UsageStats(input_tokens=50, output_tokens=15),
                model="test-model",
            ),
        ])
        result = run_agent(
            prompt="Read math_utils.py and tell me about the add function",
            model="test-model",
            workspace_root=sandbox,
            provider=fake,
        )
        assert result.stop_reason == "completed"
        assert "sum" in result.final_output.lower()
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].name == "read_file"

    def test_multi_turn_tool_calls(self, sandbox: Path) -> None:
        """Model calls list_dir, then read_file, then answers."""
        fake = FakeClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="list_dir", arguments={"path": "."}),),
                usage=UsageStats(input_tokens=30, output_tokens=5),
                model="test-model",
            ),
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c2", name="read_file", arguments={"path": "math_utils.py"}),),
                usage=UsageStats(input_tokens=50, output_tokens=5),
                model="test-model",
            ),
            AssistantTurn(
                content="I found two files. The math_utils.py file contains an add function.",
                usage=UsageStats(input_tokens=80, output_tokens=20),
                model="test-model",
            ),
        ])
        result = run_agent(
            prompt="List all files, read the Python one, and summarize",
            model="test-model",
            workspace_root=sandbox,
            provider=fake,
        )
        assert result.stop_reason == "completed"
        assert len(result.tool_calls) == 2
        assert result.turns == 3


# ---------------------------------------------------------------------------
# Tests — budget limits
# ---------------------------------------------------------------------------

class TestRunAgentBudget:
    def test_max_turns_stops(self, sandbox: Path) -> None:
        fake = FakeClient([
            AssistantTurn(
                content="",
                tool_calls=(ToolCall(id="c1", name="list_dir", arguments={}),),
                usage=UsageStats(input_tokens=10, output_tokens=5),
                model="test-model",
            ),
        ])
        result = run_agent(
            prompt="Do lots of things",
            model="test-model",
            workspace_root=sandbox,
            provider=fake,
            max_turns=1,
        )
        assert result.stop_reason == "max_turns"


# ---------------------------------------------------------------------------
# Tests — error handling
# ---------------------------------------------------------------------------

class TestRunAgentErrors:
    def test_no_api_key(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        import os
        workspace = tmp_path / "empty"
        workspace.mkdir()
        monkeypatch.setattr("xvie_agent.loop.load_dotenv", lambda *a, **kw: None)
        for key in list(os.environ):
            if key.startswith("FORGE_PROVIDER_") or key in (
                "NVIDIA_API_KEY", "NVIDIA_BASE_URL",
                "OPENROUTER_API_KEY", "FORGE_DEFAULT_PROVIDER",
            ):
                monkeypatch.delenv(key, raising=False)
        result = run_agent(
            prompt="Hi",
            model="test-model",
            workspace_root=workspace,
            api_key="",
        )
        assert result.stop_reason == "config_error"
        assert "FORGE_PROVIDER" in result.final_output


# ---------------------------------------------------------------------------
# Tests — system prompt includes context
# ---------------------------------------------------------------------------

class TestRunAgentContext:
    def test_system_prompt_includes_workspace(self, sandbox: Path) -> None:
        fake = FakeClient([
            AssistantTurn(content="OK", usage=UsageStats()),
        ])
        run_agent(
            prompt="Hi",
            model="test-model",
            workspace_root=sandbox,
            provider=fake,
        )
        first_msg = fake.calls[0]["messages"][0]
        assert first_msg["role"] == "system"
        assert str(sandbox) in first_msg["content"]

    def test_memory_files_included(self, sandbox: Path) -> None:
        (sandbox / "AGENTS.md").write_text("Always answer in bullet points.\n")
        fake = FakeClient([
            AssistantTurn(content="OK", usage=UsageStats()),
        ])
        run_agent(
            prompt="Hi",
            model="test-model",
            workspace_root=sandbox,
            provider=fake,
        )
        first_msg = fake.calls[0]["messages"][0]
        assert "bullet points" in first_msg["content"]


# ---------------------------------------------------------------------------
# Tests — system prompt freshness on resumed sessions
# ---------------------------------------------------------------------------

class TestSystemPromptRefresh:
    def test_resumed_session_gets_fresh_system_prompt(self, sandbox: Path) -> None:
        """Turn 2+ must see the rebuilt prompt, not the stale first-turn one.

        The rebuilt prompt carries fresh workspace inventory and project
        context — reusing a stale prompt left later turns running blind.
        """
        first = FakeClient([AssistantTurn("ok", usage=UsageStats())])
        session = SessionState(system_prompt="STALE FIRST-TURN PROMPT")
        run_agent(
            prompt="hello", model="m", workspace_root=sandbox,
            provider=first, existing_session=session,
        )

        second = FakeClient([AssistantTurn("ok", usage=UsageStats())])
        run_agent(
            prompt="again", model="m", workspace_root=sandbox,
            provider=second, existing_session=session,
        )
        system_msg = second.calls[0]["messages"][0]
        assert system_msg["role"] == "system"
        assert system_msg["content"] != "STALE FIRST-TURN PROMPT"
        assert "xvie-agent" in system_msg["content"]


# ---------------------------------------------------------------------------
# Tests — plan guard (return to unfinished plan tasks)
# ---------------------------------------------------------------------------

def _write_plan_file(tmp_path: Path, tasks: list[str]) -> None:
    plans_dir = tmp_path / ".xvie" / "plans"
    plans_dir.mkdir(parents=True, exist_ok=True)
    lines = ["# Plan", "## Steps", ""]
    lines += [f"- [ ] **{t}** — do {t}" for t in tasks]
    (plans_dir / "plan.md").write_text("\n".join(lines), encoding="utf-8")


class TestPlanGuard:
    def test_plan_mode_finishes_after_saving_plan(self, sandbox: Path) -> None:
        fake = FakeClient([
            AssistantTurn(
                "",
                (ToolCall(id="p1", name="write_plan", arguments={
                    "title": "Example plan",
                    "summary": "A compact plan.",
                    "steps": [{"title": "Step A", "description": "Do the work."}],
                }),),
                UsageStats(),
            ),
        ])
        result = run_agent(
            prompt="Plan a small change",
            model="m",
            workspace_root=sandbox,
            provider=fake,
            mode="plan",
            max_turns=5,
        )

        assert result.stop_reason == "completed"
        assert "Example plan" in result.final_output
        assert len(fake.calls) == 1
        assert len(result.tool_calls) == 1
        assert (sandbox / ".xvie" / "plans").exists()

    def test_nudges_back_to_unfinished_plan(self, tmp_path: Path) -> None:
        _write_plan_file(tmp_path, ["Task A", "Task B"])
        fake = FakeClient([
            AssistantTurn("", (ToolCall(id="w1", name="write_file", arguments={"path": "a.txt", "content": "A"}),), UsageStats()),
            AssistantTurn("All done!", usage=UsageStats()),
            AssistantTurn("", (ToolCall(id="m1", name="mark_task_done", arguments={"title": "Task A"}),), UsageStats()),
            AssistantTurn("", (ToolCall(id="w2", name="write_file", arguments={"path": "b.txt", "content": "B"}),), UsageStats()),
            AssistantTurn("", (ToolCall(id="m2", name="mark_task_done", arguments={"title": "Task B"}),), UsageStats()),
            AssistantTurn("Finished everything.", usage=UsageStats()),
        ])
        result = run_agent(
            prompt="build it", model="m", workspace_root=tmp_path,
            provider=fake, allow_write=True, permission_mode="accept-edits",
        )

        assert result.stop_reason == "completed"
        assert (tmp_path / "a.txt").exists()
        assert (tmp_path / "b.txt").exists()
        # The premature "All done!" was rejected with a plan nudge.
        # (Assert via transcript — FakeClient records live list references.)
        nudges = [
            m for m in result.transcript
            if m.get("role") == "user" and "unfinished task" in str(m.get("content", ""))
        ]
        assert nudges, "expected a plan-continuation nudge in the transcript"
        assert "Task A" in nudges[0]["content"]

    def test_plan_guard_is_bounded(self, tmp_path: Path) -> None:
        _write_plan_file(tmp_path, ["Task A"])
        fake = FakeClient([
            AssistantTurn("", (ToolCall(id="w1", name="write_file", arguments={"path": "a.txt", "content": "A"}),), UsageStats()),
            AssistantTurn("done 1", usage=UsageStats()),
            AssistantTurn("done 2", usage=UsageStats()),
            AssistantTurn("done 3", usage=UsageStats()),
            AssistantTurn("done 4", usage=UsageStats()),
            AssistantTurn("done 5", usage=UsageStats()),
        ])
        result = run_agent(
            prompt="build it", model="m", workspace_root=tmp_path,
            provider=fake, allow_write=True, permission_mode="accept-edits",
        )

        # After 4 nudges the guard gives up and accepts completion instead
        # of looping forever.
        assert result.stop_reason == "completed"
        assert result.final_output == "done 5"

    def test_no_guard_without_written_files(self, tmp_path: Path) -> None:
        """A chat answer must never be hijacked by a stale plan file."""
        _write_plan_file(tmp_path, ["Task A"])
        fake = FakeClient([AssistantTurn("Just answering your question.", usage=UsageStats())])
        result = run_agent(
            prompt="what is up?", model="m", workspace_root=tmp_path, provider=fake,
        )
        assert result.stop_reason == "completed"
        assert result.final_output == "Just answering your question."


# ---------------------------------------------------------------------------
# Tests — verification guard (repair invalid artifacts in-loop)
# ---------------------------------------------------------------------------

class TestVerificationGuard:
    def test_nudges_repair_on_invalid_html(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """A shallow HTML artifact must be repaired before the run ends."""
        render_calls = 0

        def fail_first_render(_path: str, _root: Path) -> str | None:
            nonlocal render_calls
            render_calls += 1
            if render_calls == 1:
                return "Responsive browser check failed: mobile layout overflows horizontally"
            return None

        monkeypatch.setattr("xvie_agent.agent.validate_responsive_render", fail_first_render)
        # Pre-create a completed plan so the plan gate and plan guard don't interfere
        plans_dir = tmp_path / ".xvie" / "plans"
        plans_dir.mkdir(parents=True, exist_ok=True)
        (plans_dir / "plan.md").write_text("# Plan\n\n## Steps\n\n- [x] **Task** - Do something\n")
        fake = FakeClient([
            AssistantTurn("", (ToolCall(id="w1", name="write_file", arguments={
                "path": "page.html",
                "content": "<html><body>hi</body></html>",
            }),), UsageStats()),
            AssistantTurn("All done!", usage=UsageStats()),
            # After the nudge the model repairs with a rich page.
            AssistantTurn("", (ToolCall(id="w2", name="write_file", arguments={
                "path": "page.html",
                "content": (
                    '<!DOCTYPE html><html lang="en"><head>'
                    '<meta name="viewport" content="width=device-width, initial-scale=1">'
                    '<title>Page</title>'
                    '<style>body{font-family:sans-serif;margin:0;display:flex;flex-direction:column;min-height:100vh}'
                    'header{background:#222;color:#fff;padding:1rem;}'
                    'main{padding:2rem;flex:1;}footer{background:#eee;padding:1rem;}'
                    '@media(max-width:768px){main{padding:1rem}}</style>'
                    '</head><body>'
                    '<header><h1>Page</h1></header>'
                    '<main><p>' + ("Substantial content. " * 40) + '</p></main>'
                    '<footer><small>Footer text</small></footer>'
                    '</body></html>'
                ),
            }),), UsageStats()),
            AssistantTurn("Repaired and verified.", usage=UsageStats()),
            # Extra response in case verification needs another turn with stricter checks.
            AssistantTurn("All fixed.", usage=UsageStats()),
        ])
        result = run_agent(
            prompt="create a website page.html", model="m", workspace_root=tmp_path,
            provider=fake, allow_write=True, permission_mode="accept-edits",
        )

        assert result.stop_reason == "completed"
        assert render_calls >= 2
        nudges = [
            m for m in result.transcript
            if m.get("role") == "user" and "failed validation" in str(m.get("content", ""))
        ]
        assert nudges, "expected a verification-repair nudge in the transcript"

    def test_guard_is_bounded(self, tmp_path: Path) -> None:
        # Pre-create a completed plan so the plan gate and plan guard don't interfere
        plans_dir = tmp_path / ".xvie" / "plans"
        plans_dir.mkdir(parents=True, exist_ok=True)
        (plans_dir / "plan.md").write_text("# Plan\n\n## Steps\n\n- [x] **Task** - Do something\n")
        fake = FakeClient([
            AssistantTurn("", (ToolCall(id="w1", name="write_file", arguments={
                "path": "page.html", "content": "<html><body>hi</body></html>",
            }),), UsageStats()),
            AssistantTurn("try 1", usage=UsageStats()),
            AssistantTurn("try 2", usage=UsageStats()),
            AssistantTurn("try 3", usage=UsageStats()),
            AssistantTurn("try 4", usage=UsageStats()),
        ])
        result = run_agent(
            prompt="create a website page.html", model="m", workspace_root=tmp_path,
            provider=fake, allow_write=True, permission_mode="accept-edits",
        )
        # After 3 repair nudges the guard gives up; detailed diagnostics stay
        # in verification state while the user gets a concise status.
        assert result.stop_reason == "verification_failed"
        assert "couldn't finish validating" in result.final_output.lower()
        assert "Artifact validation failed" not in result.final_output
        assert "HTML quality issues" not in result.final_output

    def test_no_guard_for_plain_text_answers(self, tmp_path: Path) -> None:
        fake = FakeClient([AssistantTurn("Just answering.", usage=UsageStats())])
        result = run_agent(
            prompt="what is 2+2?", model="m", workspace_root=tmp_path, provider=fake,
        )
        assert result.stop_reason == "completed"
        assert result.final_output == "Just answering."


class TestUiDesignLaneAutoSelect:
    def _spy_loop(self, monkeypatch: pytest.MonkeyPatch) -> dict:
        import xvie_agent.loop as loop_mod
        from xvie_agent.agent import AgentLoop as RealLoop
        seen: dict = {}

        class SpyLoop(RealLoop):
            def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
                seen.update(kwargs)
                super().__init__(*args, **kwargs)

        monkeypatch.setattr(loop_mod, "AgentLoop", SpyLoop)
        return seen

    def test_website_prompt_selects_ui_design_lane(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        seen = self._spy_loop(monkeypatch)
        fake = FakeClient([AssistantTurn("A plan will follow.", usage=UsageStats())])
        run_agent(
            prompt="create a website landing page", model="m",
            workspace_root=tmp_path, provider=fake,
        )
        assert seen.get("lane") == "ui_design"

    def test_non_website_prompt_keeps_auto_lane(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        seen = self._spy_loop(monkeypatch)
        fake = FakeClient([AssistantTurn("Fixed.", usage=UsageStats())])
        run_agent(
            prompt="fix the bug in utils.py", model="m",
            workspace_root=tmp_path, provider=fake,
        )
        assert seen.get("lane") != "ui_design"

    def test_explicit_lane_wins_over_auto(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        seen = self._spy_loop(monkeypatch)
        fake = FakeClient([AssistantTurn("A plan will follow.", usage=UsageStats())])
        run_agent(
            prompt="create a website landing page", model="m",
            workspace_root=tmp_path, provider=fake, lane="coding",
        )
        assert seen.get("lane") == "coding"


class TestStagnationGuard:
    def _plan_with_open_task(self, tmp_path: Path) -> None:
        plans_dir = tmp_path / ".xvie" / "plans"
        plans_dir.mkdir(parents=True, exist_ok=True)
        (plans_dir / "plan.md").write_text(
            "# Plan\n\n## Steps\n\n- [ ] **Build thing** — Do it (files: `a.py`)\n",
            encoding="utf-8",
        )

    def test_rejection_silence_forces_repair(self, tmp_path: Path) -> None:
        self._plan_with_open_task(tmp_path)
        fake = FakeClient([
            AssistantTurn("", (ToolCall(id="d1", name="mark_task_done", arguments={
                "title": "Build thing",
            }),), UsageStats()),
            AssistantTurn("", usage=UsageStats()),
            AssistantTurn("", (ToolCall(id="l1", name="list_dir", arguments={"path": "."}),), UsageStats()),
            AssistantTurn("Done.", usage=UsageStats()),
        ])
        result = run_agent(
            prompt="fix the bug in utils.py", model="m",
            workspace_root=tmp_path, provider=fake,
        )
        texts = [str(m.get("content", "")) for m in result.transcript]
        assert any("REJECTED" in t for t in texts), texts
        assert fake._idx == 4

    def test_narrating_own_plan_forces_action(self, tmp_path: Path) -> None:
        # Plan written THIS run, then narration instead of execution:
        # the run must force a tool call, not accept the narration.
        fake = FakeClient([
            AssistantTurn("", (ToolCall(id="p1", name="write_plan", arguments={
                "title": "Build thing",
                "summary": "Do it.",
                "steps": [{"title": "Build", "description": "Do it.", "files_touched": ["a.py"]}],
            }),), UsageStats()),
            AssistantTurn("I have a plan, starting now.", usage=UsageStats()),
            AssistantTurn("", (ToolCall(id="w1", name="write_file", arguments={
                "path": "a.py", "content": "x = 1\n",
            }),), UsageStats()),
            AssistantTurn("", (ToolCall(id="d1", name="mark_task_done", arguments={
                "title": "Build",
            }),), UsageStats()),
            AssistantTurn("Done.", usage=UsageStats()),
        ])
        result = run_agent(
            prompt="fix the bug in utils.py", model="m",
            workspace_root=tmp_path, provider=fake, allow_write=True,
            permission_mode="accept-edits",
        )
        texts = [str(m.get("content", "")) for m in result.transcript]
        assert any("banned this turn" in t for t in texts), texts
        assert fake._idx == 5
        assert result.stop_reason == "completed"

    def test_novel_text_with_open_tasks_completes(self, tmp_path: Path) -> None:
        # A single novel status line is an answer, not stagnation — even
        # with a stale open plan lying around. Only repeats/empties force.
        self._plan_with_open_task(tmp_path)
        fake = FakeClient([AssistantTurn("Here is my status update.", usage=UsageStats())])
        result = run_agent(
            prompt="what is the status?", model="m",
            workspace_root=tmp_path, provider=fake,
        )
        assert result.stop_reason == "completed"
        assert fake._idx == 1

    def test_legitimate_finish_not_forced(self, tmp_path: Path) -> None:
        fake = FakeClient([AssistantTurn("Just answering.", usage=UsageStats())])
        result = run_agent(
            prompt="what is 2+2?", model="m", workspace_root=tmp_path, provider=fake,
        )
        assert result.stop_reason == "completed"
        assert result.final_output == "Just answering."
        assert fake._idx == 1


class TestThinkingCutForceAction:
    def test_force_nudge_after_two_thinking_truncations(self, tmp_path: Path) -> None:
        fake = FakeClient([
            AssistantTurn("thinking part one...", truncated=True, usage=UsageStats()),
            AssistantTurn("thinking part two...", truncated=True, usage=UsageStats()),
            AssistantTurn("", (ToolCall(id="l1", name="list_dir", arguments={"path": "."}),), UsageStats()),
            AssistantTurn("Done.", usage=UsageStats()),
        ])
        result = run_agent(
            prompt="fix the bug in utils.py", model="m",
            workspace_root=tmp_path, provider=fake,
        )
        nudges = [
            str(m.get("content", "")) for m in result.transcript
            if m.get("role") == "user"
        ]
        assert any("BANNED for this turn" in n for n in nudges), nudges

    def test_single_truncation_stays_gentle(self, tmp_path: Path) -> None:
        fake = FakeClient([
            AssistantTurn("thinking part one...", truncated=True, usage=UsageStats()),
            AssistantTurn("", (ToolCall(id="l1", name="list_dir", arguments={"path": "."}),), UsageStats()),
            AssistantTurn("Done.", usage=UsageStats()),
        ])
        result = run_agent(
            prompt="fix the bug in utils.py", model="m",
            workspace_root=tmp_path, provider=fake,
        )
        nudges = [
            str(m.get("content", "")) for m in result.transcript
            if m.get("role") == "user"
        ]
        assert not any("BANNED for this turn" in n for n in nudges)


class TestRecolorGuidance:
    def test_apply_patch_description_teaches_swaps(self) -> None:
        from xvie_agent.tools import ToolContext, build_default_registry
        import tempfile
        from pathlib import Path
        ctx = ToolContext(workspace_root=Path(tempfile.mkdtemp()), allow_write=True, allow_shell=False)
        desc = build_default_registry(ctx)["apply_patch"].description.lower()
        assert "palette" in desc and "instead of rewriting" in desc

    def test_design_layer_teaches_token_swaps(self) -> None:
        from xvie_agent.design_guidance import inject_design_principles
        result = inject_design_principles("base", "ui_design")
        assert "token swaps" in result.lower()
        assert "never" in result.lower() and "rewrite" in result.lower()


class TestPlanModeDesignTools:
    def test_plan_mode_keeps_readonly_design_tools(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        import xvie_agent.loop as loop_mod
        from xvie_agent.agent import AgentLoop as RealLoop
        seen: dict = {}

        class SpyLoop(RealLoop):
            def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
                seen.update(kwargs)
                super().__init__(*args, **kwargs)

        monkeypatch.setattr(loop_mod, "AgentLoop", SpyLoop)
        fake = FakeClient([AssistantTurn("Plan text.", usage=UsageStats())])
        run_agent(
            prompt="plan a website landing page", model="m",
            workspace_root=tmp_path, provider=fake, mode="plan",
        )
        tools = seen.get("tools", {})
        assert "read_ui_reference" in tools
        assert "check_contrast" in tools
        assert "verify_file" in tools
        assert "write_file" not in tools
        assert "bash" not in tools
