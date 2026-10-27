from __future__ import annotations

import time
import threading

from fastapi.testclient import TestClient

from xvie_agent import service
from xvie_agent.session import SessionState
from xvie_agent.store import save_session
from xvie_agent.types import AgentEvent, AgentRunResult, AssistantTurn, ToolCall, UsageStats


def client(monkeypatch):
    monkeypatch.setenv("XVIE_AGENT_TOKEN", "test-secret")
    return TestClient(service.app), {"Authorization": "Bearer test-secret"}


def wait_for_run(api, headers, run_id):
    deadline = time.time() + 3
    while time.time() < deadline:
        payload = api.get(f"/runs/{run_id}/events", headers=headers).json()
        if not payload["running"]:
            return payload["events"]
        time.sleep(0.01)
    raise AssertionError("Agent run did not finish before timeout.")


def result(session_id, *, output="Finished", reason="completed", approval=False):
    return AgentRunResult(
        final_output=output,
        turns=1,
        tool_calls=(),
        usage=UsageStats(input_tokens=1, output_tokens=2),
        stop_reason=reason,
        confirmation_required=approval,
        session_id=session_id,
    )


def test_health_requires_loopback_token(monkeypatch):
    api, headers = client(monkeypatch)
    assert api.get("/health").status_code == 401
    response = api.get("/health", headers=headers)
    assert response.status_code == 200
    assert response.json()["agent"] == "xvie-agent"


def test_provider_list_returns_metadata_without_credentials(monkeypatch):
    api, headers = client(monkeypatch)
    monkeypatch.setenv("DEFAULT_MODEL", "example-model")
    secret = "provider-secret"
    monkeypatch.setattr(service, "load_providers_from_env", lambda: {
        "nvidia": service.ProviderClient(config=service.ProviderConfig(
            name="nvidia", api_key=secret, base_url="https://provider.example/v1"
        ))
    })
    response = api.get("/providers", headers=headers)
    assert response.status_code == 200
    assert response.json() == {"providers": [{
        "name": "nvidia", "base_url": "https://provider.example/v1",
        "model": "example-model", "configured": True,
    }]}
    assert secret not in response.text


def test_run_streams_activity_and_final_result(monkeypatch, tmp_path):
    api, headers = client(monkeypatch)
    captured = {}

    class Result:
        session_id = "service-session"
        final_output = "Finished"
        stop_reason = "completed"
        turns = 1
        tool_calls = ()
        usage = UsageStats(input_tokens=1, output_tokens=2)
        confirmation_required = False
        verification_outcome = "passed"

    def fake_run_agent(**kwargs):
        captured.update(kwargs)
        kwargs["event_callback"](AgentEvent("inspecting", "Inspecting workspace"))
        return Result()

    monkeypatch.setattr(service, "run_agent", fake_run_agent)
    started = api.post("/runs", headers=headers, json={
        "prompt": "Explain this project",
        "workspace_root": str(tmp_path),
    })
    assert started.status_code == 200
    run_id = started.json()["session_id"]
    deadline = time.time() + 2
    while time.time() < deadline:
        payload = api.get(f"/runs/{run_id}/events", headers=headers).json()
        if not payload["running"]:
            break
        time.sleep(0.01)
    assert [event["type"] for event in payload["events"]] == ["activity", "completed"]
    assert captured["mode"] == "code"
    assert captured["allow_write"] is True
    assert payload["events"][-1]["result"]["final_output"] == "Finished"


def test_greeting_gets_a_direct_saved_reply_without_calling_model(monkeypatch, tmp_path):
    api, headers = client(monkeypatch)

    def unexpected_model_call(**kwargs):
        raise AssertionError("A greeting should not invoke the provider")

    monkeypatch.setattr(service, "run_agent", unexpected_model_call)
    started = api.post("/runs", headers=headers, json={
        "prompt": "Hello", "workspace_root": str(tmp_path), "mode": "code",
    }).json()
    events = wait_for_run(api, headers, started["session_id"])
    assert events[-1]["result"]["final_output"] == "Hi! What would you like to work on?"
    saved = api.get(f"/sessions/{started['session_id']}", headers=headers, params={"workspace_root": str(tmp_path)}).json()
    assert [message["content"] for message in saved["messages"]] == ["Hello", "Hi! What would you like to work on?"]


def test_explanation_prompt_keeps_code_mode_model_decides(monkeypatch, tmp_path):
    api, headers = client(monkeypatch)
    captured = {}

    def fake_run_agent(**kwargs):
        captured.update(kwargs)
        return result(kwargs["existing_session"].session_id, output="Project overview")

    monkeypatch.setattr(service, "run_agent", fake_run_agent)
    started = api.post("/runs", headers=headers, json={
        "prompt": "Brief me on the project",
        "workspace_root": str(tmp_path), "mode": "code",
        "allow_write": True, "allow_shell": True,
    }).json()
    wait_for_run(api, headers, started["session_id"])
    assert captured["mode"] == "code"
    assert captured["allow_write"] is True
    assert captured["allow_shell"] is True


def test_explicit_edit_request_keeps_code_mode(monkeypatch, tmp_path):
    api, headers = client(monkeypatch)
    captured = {}

    def fake_run_agent(**kwargs):
        captured.update(kwargs)
        return result(kwargs["existing_session"].session_id)

    monkeypatch.setattr(service, "run_agent", fake_run_agent)
    started = api.post("/runs", headers=headers, json={
        "prompt": "Please update the settings screen",
        "workspace_root": str(tmp_path), "mode": "code",
    }).json()
    wait_for_run(api, headers, started["session_id"])
    assert captured["mode"] == "code"


def test_please_just_apply_request_keeps_code_write_access(monkeypatch, tmp_path):
    api, headers = client(monkeypatch)
    captured = {}

    def fake_run_agent(**kwargs):
        captured.update(kwargs)
        return result(kwargs["existing_session"].session_id)

    monkeypatch.setattr(service, "run_agent", fake_run_agent)
    started = api.post("/runs", headers=headers, json={
        "prompt": "Please just apply the changes your self. Now don't tell me to apply them myself.",
        "workspace_root": str(tmp_path),
        "mode": "code",
    }).json()
    wait_for_run(api, headers, started["session_id"])

    assert captured["mode"] == "code"
    assert captured["allow_write"] is True
    assert captured["allow_shell"] is True


def test_apply_action_is_a_write_workflow():
    from xvie_agent.workflow import classify_workflow

    workflow = classify_workflow("Please just apply the changes your self.")

    assert workflow.kind == "edit"
    assert workflow.needs_write_confirmation is True


def test_long_and_save_requests_keep_code_mode(monkeypatch, tmp_path):
    api, headers = client(monkeypatch)
    captured = []

    def fake_run_agent(**kwargs):
        captured.append(kwargs["mode"])
        return result(kwargs["existing_session"].session_id)

    monkeypatch.setattr(service, "run_agent", fake_run_agent)
    prompts = [
        "Please save this to a file.",
        "I want you to help me edit it.",
        "Review the current page and, after that, please help me add better images and save it.",
        "Could you please save the code to a file?",
        "Could you explain how to edit this file?",
    ]
    for prompt in prompts:
        started = api.post("/runs", headers=headers, json={
            "prompt": prompt, "workspace_root": str(tmp_path), "mode": "code",
        }).json()
        wait_for_run(api, headers, started["session_id"])
    assert captured == ["code", "code", "code", "code", "code"]


def test_explicit_read_only_modes_override_save_intent(tmp_path):
    prompt = "Please save this to a file."
    assert service._effective_mode(service.RunRequest(
        prompt=prompt, workspace_root=str(tmp_path), mode="plan",
    )) == "plan"
    assert service._effective_mode(service.RunRequest(
        prompt=prompt, workspace_root=str(tmp_path), mode="ask",
    )) == "ask"


def test_save_request_runs_write_tool_and_verifies_file(monkeypatch, tmp_path):
    api, headers = client(monkeypatch)
    plans = tmp_path / ".xvie" / "plans"
    plans.mkdir(parents=True)
    (plans / "approved-plan.md").write_text("# Save note.json\n- [x] **Write note.json** - saved\n")

    class FakeProvider:
        provider_name = "test"

        def __init__(self):
            self.turns = [
                AssistantTurn(
                    "",
                    (ToolCall("write-1", "write_file", {"path": "note.json", "content": '{"saved":true}'}),),
                    model="test-model",
                ),
                AssistantTurn(
                    "",
                    (ToolCall("verify-1", "verify_file", {"path": "note.json"}),),
                    model="test-model",
                ),
                AssistantTurn("Saved note.json.", model="test-model"),
            ]

        def complete(self, **_kwargs):
            return self.turns.pop(0)

    provider = FakeProvider()
    monkeypatch.setattr(service, "ProviderClient", lambda **_kwargs: provider)
    started = api.post("/runs", headers=headers, json={
        "prompt": "Please save this to note.json.",
        "workspace_root": str(tmp_path),
        "mode": "code",
        "api_key": "test-key",
        "base_url": "https://provider.example/v1",
        "write_approved": True,
    }).json()
    events = wait_for_run(api, headers, started["session_id"])
    final = events[-1]["result"]
    assert (tmp_path / "note.json").read_text(encoding="utf-8") == '{"saved":true}'
    assert final["stop_reason"] == "completed"
    assert [call["name"] for call in final["tool_calls"]] == ["write_file", "verify_file"]


def test_session_continuation_reuses_saved_state(monkeypatch, tmp_path):
    api, headers = client(monkeypatch)
    calls = []

    def fake_run_agent(**kwargs):
        session = kwargs["existing_session"]
        calls.append((session.session_id, len(session.messages)))
        session.append_user(kwargs["prompt"])
        save_session(session, kwargs["sessions_dir"])
        return result(session.session_id)

    monkeypatch.setattr(service, "run_agent", fake_run_agent)
    first = api.post("/runs", headers=headers, json={"prompt": "first", "workspace_root": str(tmp_path)}).json()
    wait_for_run(api, headers, first["session_id"])
    second = api.post("/runs", headers=headers, json={
        "prompt": "follow up", "workspace_root": str(tmp_path), "session_id": first["session_id"]
    }).json()
    wait_for_run(api, headers, second["session_id"])
    assert calls[0][0] == calls[1][0] == first["session_id"]
    assert calls[1][1] == 1


def test_plan_approval_resumes_with_write_approval(monkeypatch, tmp_path):
    api, headers = client(monkeypatch)
    calls = []

    def fake_run_agent(**kwargs):
        session = kwargs["existing_session"]
        calls.append({"write_approved": kwargs["write_approved"], "allow_write": kwargs["allow_write"], "plan_gate": kwargs["plan_gate"]})
        session.append_user(kwargs["prompt"])
        if len(calls) == 1:
            session.execution_state = {"phase": "awaiting_approval", "proposed_plan": "1. Update the file"}
            save_session(session, kwargs["sessions_dir"])
            return result(session.session_id, output="1. Update the file", reason="awaiting_approval", approval=True)
        return result(session.session_id)

    monkeypatch.setattr(service, "run_agent", fake_run_agent)
    started = api.post("/runs", headers=headers, json={
        "prompt": "Add a setting", "workspace_root": str(tmp_path), "mode": "code",
        "allow_write": True, "allow_shell": True, "write_approved": False,
    }).json()
    events = wait_for_run(api, headers, started["session_id"])
    assert events[-1]["result"]["confirmation_required"] is True
    assert calls[0] == {"write_approved": False, "allow_write": True, "plan_gate": True}

    response = api.post(f"/runs/{started['session_id']}/approve", headers=headers)
    assert response.status_code == 200
    events = wait_for_run(api, headers, started["session_id"])
    assert events[-1]["result"]["stop_reason"] == "completed"
    assert calls[1]["write_approved"] is True


def test_stop_signals_active_run(monkeypatch, tmp_path):
    api, headers = client(monkeypatch)
    entered = threading.Event()

    def fake_run_agent(**kwargs):
        entered.set()
        assert kwargs["cancel_event"].wait(2)
        return result(kwargs["existing_session"].session_id, output="Stopped", reason="cancelled")

    monkeypatch.setattr(service, "run_agent", fake_run_agent)
    started = api.post("/runs", headers=headers, json={"prompt": "Inspect", "workspace_root": str(tmp_path)}).json()
    assert entered.wait(1)
    stopped = api.post(f"/runs/{started['session_id']}/stop", headers=headers)
    assert stopped.status_code == 200
    events = wait_for_run(api, headers, started["session_id"])
    assert events[-1]["result"]["stop_reason"] == "cancelled"


def test_rejects_workspace_outside_existing_directory(monkeypatch, tmp_path):
    api, headers = client(monkeypatch)
    response = api.post("/runs", headers=headers, json={
        "prompt": "Inspect",
        "workspace_root": str(tmp_path / "missing"),
    })
    assert response.status_code == 400
