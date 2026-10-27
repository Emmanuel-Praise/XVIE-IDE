"""Regression coverage for the agent reliability workflow."""

from pathlib import Path

from xvie_agent.agent import AgentLoop
from xvie_agent.loop import run_agent
from xvie_agent.session import SessionState
from xvie_agent.tools import ToolContext, build_default_registry
from xvie_agent.types import AssistantTurn, ToolCall, UsageStats
from xvie_agent.workflow import classify_workflow
from xvie_agent.execution import run_verification, validate_changed_file


class FakeClient:
    provider_name = "fake"

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def complete(self, model, messages, tools=None, **kwargs):
        self.calls.append({"messages": messages, "tools": tools})
        return self.responses.pop(0)

    def close(self):
        pass


def test_improvement_prompt_requires_project_inspection():
    workflow = classify_workflow("Suggest improvements for this project")
    assert workflow.kind == "suggest"
    assert workflow.needs_project_inspection is True
    assert workflow.needs_write_confirmation is False


def test_question_about_add_function_is_not_an_edit_request():
    workflow = classify_workflow("What does the add function do?")
    assert workflow.kind != "edit"
    assert workflow.needs_write_confirmation is False


def test_write_is_blocked_until_approved(tmp_path: Path):
    # Pre-create a completed plan so the plan gate and plan guard don't interfere
    plans_dir = tmp_path / ".xvie" / "plans"
    plans_dir.mkdir(parents=True, exist_ok=True)
    (plans_dir / "plan.md").write_text("# Plan\n\n## Steps\n\n- [x] **Task** - Do something\n")
    client = FakeClient([
        AssistantTurn("", (ToolCall("w1", "write_file", {"path": "new.txt", "content": "new"}),), UsageStats()),
        AssistantTurn("I need approval before I change new.txt.", usage=UsageStats()),
    ])
    events = []
    ctx = ToolContext(workspace_root=tmp_path, allow_write=True)
    result = AgentLoop(
        client=client, model="test", tools=build_default_registry(ctx), tool_ctx=ctx,
        confirmation_required=True, event_callback=events.append,
    ).run("Create a file")

    assert not (tmp_path / "new.txt").exists()
    assert result.confirmation_required is True
    assert any(event.kind == "awaiting_confirmation" for event in events)


def test_session_history_is_sent_on_follow_up(tmp_path: Path):
    session = SessionState()
    first = FakeClient([AssistantTurn("First answer", usage=UsageStats(), model="test")])
    run_agent("Hello", "test", tmp_path, provider=first, existing_session=session)

    second = FakeClient([AssistantTurn("Second answer", usage=UsageStats(), model="test")])
    run_agent("What did you just say?", "test", tmp_path, provider=second, existing_session=session)

    prior_content = [message.get("content", "") for message in second.calls[0]["messages"]]
    assert "Hello" in prior_content
    assert "First answer" in prior_content


def test_invalid_tool_arguments_emit_repair_event(tmp_path: Path):
    client = FakeClient([
        AssistantTurn("", (ToolCall("r1", "read_file", {}),), UsageStats()),
        AssistantTurn("I need a file path.", usage=UsageStats()),
    ])
    events = []
    ctx = ToolContext(workspace_root=tmp_path)
    result = AgentLoop(client, "test", build_default_registry(ctx), ctx, event_callback=events.append).run("Read a file")

    assert result.final_output == "I need a file path."
    assert any(event.kind == "retrying" for event in events)


def test_coding_request_becomes_persisted_pending_plan(tmp_path: Path):
    session = SessionState()
    client = FakeClient([AssistantTurn("Plan: update hello.py and add a test.", usage=UsageStats(), model="test")])
    result = run_agent("Update hello.py", "test", tmp_path, provider=client, existing_session=session, allow_write=True)

    assert result.stop_reason == "awaiting_approval"
    assert session.execution_state["phase"] == "awaiting_approval"
    assert "update hello.py" in session.execution_state["proposed_plan"].lower()
    assert "write_file" in {tool["function"]["name"] for tool in client.calls[0]["tools"]}


def test_write_attempt_before_approval_returns_to_planning(tmp_path: Path):
    session = SessionState()
    client = FakeClient([
        AssistantTurn("", (ToolCall("w1", "write_file", {"path": "site.html", "content": "x"}),), UsageStats()),
        AssistantTurn("Plan: create site.html with the requested school layout, then test it.", usage=UsageStats()),
    ])
    result = run_agent("Create a school website", "test", tmp_path, provider=client, existing_session=session)

    assert result.stop_reason == "awaiting_approval"
    assert not (tmp_path / "site.html").exists()
    assert "Plan:" in result.final_output
    assert "unavailable" not in result.final_output.lower()


def test_approval_resumes_pending_implementation(tmp_path: Path):
    # Pre-create a completed plan so the plan gate and plan guard don't interfere
    plans_dir = tmp_path / ".xvie" / "plans"
    plans_dir.mkdir(parents=True, exist_ok=True)
    (plans_dir / "plan.md").write_text("# Plan\n\n## Steps\n\n- [x] **Task** - Do something\n")
    session = SessionState(execution_state={
        "task_kind": "edit", "prompt": "Create hello.txt", "phase": "awaiting_approval",
        "approved": False, "inspected_files": [], "proposed_plan": "Create hello.txt",
        "changed_files": [], "verification_command": "", "verification_output": "",
        "verification_outcome": "not_run", "final_outcome": "",
    })
    client = FakeClient([
        AssistantTurn("", (ToolCall("w1", "write_file", {"path": "hello.txt", "content": "hello"}),), UsageStats()),
        AssistantTurn("Implemented.", usage=UsageStats()),
    ])
    result = run_agent("ignored", "test", tmp_path, provider=client, existing_session=session, allow_write=True, write_approved=True)

    assert (tmp_path / "hello.txt").read_text() == "hello"
    assert result.stop_reason == "completed"
    assert session.execution_state["changed_files"] == ["hello.txt"]


def test_accept_edits_still_blocks_shell_commands(tmp_path: Path):
    client = FakeClient([
        AssistantTurn("", (ToolCall("s1", "bash", {"command": "echo unsafe"}),), UsageStats()),
        AssistantTurn("I need approval to run that command.", usage=UsageStats()),
    ])
    result = run_agent(
        "Update hello.py", "test", tmp_path, provider=client,
        allow_write=True, allow_shell=True, permission_mode="accept-edits",
    )

    assert result.stop_reason == "completed"
    tool_results = [item for item in result.transcript if item.get("role") == "tool"]
    assert tool_results[0]["content"].startswith("Approval is required")


def test_run_stream_yields_events_before_completion(tmp_path: Path):
    client = FakeClient([AssistantTurn("Done", usage=UsageStats())])
    loop = AgentLoop(client, "test")
    events = list(loop.run_stream("Hello"))

    assert any(event.kind == "understanding_task" for event in events)
    assert loop.last_result is not None
    assert loop.last_result.final_output == "Done"


def test_verifier_uses_real_exit_status(tmp_path: Path):
    passed, output = run_verification("python -c \"raise SystemExit(3)\"", tmp_path, 10)
    assert passed is False
    assert "exit code: 3" in output


def test_html_validator_rejects_partial_document(tmp_path: Path):
    (tmp_path / "broken.html").write_text("<html><head><title>Broken</title><link rel=", encoding="utf-8")
    error = validate_changed_file("broken.html", tmp_path)

    assert error is not None
    assert "Incomplete HTML" in error or "Incomplete HTML tag" in error


def test_partial_html_write_is_not_blocked_in_loop(tmp_path: Path):
    """Partial writes must NOT fail in the loop — chunked builds rely on it.

    Validation now happens only via the explicit verify_file tool and the
    post-run check in run_agent, so an incomplete first chunk is allowed to
    exist while the model continues appending (prevents a repair loop).
    """
    # Pre-create a completed plan so the plan gate and plan guard don't interfere
    plans_dir = tmp_path / ".xvie" / "plans"
    plans_dir.mkdir(parents=True, exist_ok=True)
    (plans_dir / "plan.md").write_text("# Plan\n\n## Steps\n\n- [x] **Task** - Do something\n")
    client = FakeClient([
        AssistantTurn("", (ToolCall("w1", "write_file", {"path": "site.html", "content": "<!DOCTYPE html><html><head><title>X</title>"}),), UsageStats()),
        AssistantTurn("Done writing.", usage=UsageStats()),
        # After the completion-time verification nudge the model finishes the doc.
        AssistantTurn("", (ToolCall("w2", "edit_file", {"path": "site.html", "old_str": "<title>X</title>", "new_str": "<title>X</title></head><body><h1>X</h1></body></html>"}),), UsageStats()),
        AssistantTurn("Completed the site.", usage=UsageStats()),
    ])
    ctx = ToolContext(workspace_root=tmp_path, allow_write=True)
    result = AgentLoop(client, "test", build_default_registry(ctx), ctx).run("Write a site")

    tool_messages = [message for message in result.transcript if message.get("role") == "tool"]
    # The chunk write succeeds; nothing fails at write time.
    # Output can start with 'Created' (new file) or 'Written' (overwrite)
    assert tool_messages[0]["content"].startswith(("Written", "Created"))
    # The incomplete chunk is repaired before the run may end.
    assert "</body>" in (tmp_path / "site.html").read_text()


def test_stub_completion_does_not_stop_loop(tmp_path: Path):
    """A status-only reply after writing a tiny stub must NOT end the run.

    The user asked for a 1000-line file; the model wrote a 1-line stub and
    replied 'The function call has been executed successfully'. The loop
    must detect this and force the model to keep building instead of
    returning 'completed'.
    """
    # Pre-create a completed plan so the plan gate and plan guard don't interfere
    plans_dir = tmp_path / ".xvie" / "plans"
    plans_dir.mkdir(parents=True, exist_ok=True)
    (plans_dir / "plan.md").write_text("# Plan\n\n## Steps\n\n- [x] **Task** - Do something\n")
    client = FakeClient([
        AssistantTurn("", (ToolCall("w1", "write_file", {"path": "shop.html", "content": "<!DOCTYPE html><html><head><title>Shop</title>"}),), UsageStats()),
        AssistantTurn("The function call to write the shop.html file has been executed successfully.", usage=UsageStats()),
        AssistantTurn("", (ToolCall("w2", "append_file", {"path": "shop.html", "content": "</head><body><h1>Shop</h1></body></html>"}),), UsageStats()),
        AssistantTurn("Done.", usage=UsageStats()),
    ])
    ctx = ToolContext(workspace_root=tmp_path, allow_write=True)
    result = AgentLoop(client, "test", build_default_registry(ctx), ctx).run("build me a shop website with at least 1000 lines, name it shop.html")

    # The loop should NOT have stopped after the status-only reply — it
    # should have continued to the append_file call.
    assert len(result.tool_calls) >= 2
    assert result.tool_calls[1].name == "append_file"
    # The final file should contain the appended content.
    assert "Shop" in (tmp_path / "shop.html").read_text()
