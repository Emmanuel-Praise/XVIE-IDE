"""Tests for the ask_question pause-and-wait tool."""

from __future__ import annotations

from pathlib import Path

from xvie_agent.agent import _format_question_answers, _normalize_questions
from xvie_agent.tools import ToolContext, build_default_registry


class TestAskQuestionTool:
    def test_registered(self, tmp_path: Path):
        ctx = ToolContext(workspace_root=tmp_path)
        reg = build_default_registry(ctx)
        assert "ask_question" in reg

    def test_validation_rejects_empty(self, tmp_path: Path):
        ctx = ToolContext(workspace_root=tmp_path)
        reg = build_default_registry(ctx)
        out = reg["ask_question"].handler({}, ctx)
        assert out.ok is False

    def test_validation_accepts_shape(self, tmp_path: Path):
        ctx = ToolContext(workspace_root=tmp_path)
        reg = build_default_registry(ctx)
        out = reg["ask_question"].handler(
            {"questions": [{"id": "scope", "question": "Which scope?",
                            "header": "Scope",
                            "options": [{"label": "A"}, {"label": "B"}],
                            "allow_custom": True}]},
            ctx,
        )
        assert out.ok is True
        assert out.error_kind == "awaiting_input"

    def test_normalize_caps(self):
        raw = [{"id": f"q{i}", "question": f"Q{i}?", "options": [{"label": f"O{j}"} for j in range(10)]}
               for i in range(10)]
        norm = _normalize_questions(raw)
        assert len(norm) == 4
        assert len(norm[0]["options"]) == 5

    def test_format_answers(self):
        questions = [{"id": "scope", "question": "Which?", "header": "",
                      "options": [], "allow_custom": True}]
        text = _format_question_answers(
            questions, [{"id": "scope", "selected": ["A"], "custom_text": "extra"}])
        assert "scope" in text and "A" in text and "extra" in text
        skipped = _format_question_answers(questions, [])
        assert "best guess" in skipped


class TestAskQuestionLoop:
    def test_loop_pauses_and_resumes(self, tmp_path: Path, monkeypatch):
        """AgentLoop intercepts ask_question, calls question_callback, feeds answers."""
        from xvie_agent.agent import AgentLoop
        from xvie_agent.providers.base import ProviderClient, ProviderConfig
        from xvie_agent.types import AssistantTurn, UsageStats

        asked: list = []

        def fake_callback(questions: list[dict]):
            asked.extend(questions)
            return [{"id": "scope", "selected": ["A"], "custom_text": ""}]

        class FakeClient(ProviderClient):
            def __init__(self):
                pass

            def stream(self, **kwargs):
                turns = getattr(self, "_turns", 0)
                self._turns = turns + 1
                if turns == 0:
                    from xvie_agent.types import StreamEvent, ToolCall
                    yield StreamEvent(tool_call=ToolCall(
                        id="c1", name="ask_question",
                        arguments={"questions": [{"id": "scope", "question": "Which scope?",
                                                  "options": [{"label": "A"}, {"label": "B"}]}]}))
                    from xvie_agent.types import UsageStats as U
                    yield StreamEvent(usage=U(), done=True)
                else:
                    from xvie_agent.types import StreamEvent
                    yield StreamEvent(text_delta="Done with A.")
                    from xvie_agent.types import UsageStats as U
                    yield StreamEvent(usage=U(), done=True)

        ctx = ToolContext(workspace_root=tmp_path)
        reg = build_default_registry(ctx)
        loop = AgentLoop(client=FakeClient(), model="test", tools=reg, tool_ctx=ctx,
                         question_callback=fake_callback)
        result = loop.run("Do the thing")
        assert asked and asked[0]["id"] == "scope"
        assert "Done with A" in result.final_output
        assert any(tc.name == "ask_question" for tc in result.tool_calls)
