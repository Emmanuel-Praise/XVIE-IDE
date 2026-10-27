"""Tests for xvie_agent.session — round-trip serialization and wire format."""

from __future__ import annotations

import json

import pytest

from xvie_agent.session import AgentMessage, SessionState
from xvie_agent.types import ToolCall, UsageStats


# ---------------------------------------------------------------------------
# AgentMessage construction
# ---------------------------------------------------------------------------

class TestAgentMessage:
    def test_basic_construction(self) -> None:
        msg = AgentMessage(role="user", content="Hello")
        assert msg.role == "user"
        assert msg.content == "Hello"
        assert msg.tool_calls is None
        assert msg.tool_call_id is None
        assert msg.name is None
        assert isinstance(msg.message_id, str)
        assert len(msg.message_id) == 36  # UUID format

    def test_tool_result_message(self) -> None:
        msg = AgentMessage(role="tool", content="file contents", tool_call_id="call_123", name="read_file")
        assert msg.tool_call_id == "call_123"
        assert msg.name == "read_file"

    def test_assistant_with_tool_calls(self) -> None:
        tc = ToolCall(id="c1", name="ls", arguments={"path": "."})
        msg = AgentMessage(role="assistant", content="", tool_calls=[tc], usage=UsageStats(input_tokens=10))
        assert len(msg.tool_calls) == 1
        assert msg.usage.input_tokens == 10


# ---------------------------------------------------------------------------
# SessionState — append methods
# ---------------------------------------------------------------------------

class TestSessionAppend:
    def test_visible_thoughts_survive_round_trip(self) -> None:
        session = SessionState()
        session.visible_thoughts.append({"text": "Read the config before editing.", "timestamp": "2026-01-01T00:00:00Z", "duration_ms": 2400})
        restored = SessionState.from_json(session.to_json())
        assert restored.visible_thoughts == session.visible_thoughts

    def test_append_user(self) -> None:
        s = SessionState(system_prompt="You are helpful.")
        msg = s.append_user("Hi there")
        assert msg.role == "user"
        assert msg.content == "Hi there"
        assert len(s.messages) == 1

    def test_append_assistant_text(self) -> None:
        s = SessionState()
        s.append_user("Hi")
        msg = s.append_assistant("Hello!")
        assert msg.role == "assistant"
        assert msg.content == "Hello!"
        assert msg.tool_calls is None

    def test_append_assistant_with_tools(self) -> None:
        s = SessionState()
        tc = ToolCall(id="c1", name="read_file", arguments={"path": "x.py"})
        msg = s.append_assistant("", tool_calls=[tc], usage=UsageStats(input_tokens=5))
        assert len(msg.tool_calls) == 1
        assert msg.usage.input_tokens == 5

    def test_append_tool_result(self) -> None:
        s = SessionState()
        msg = s.append_tool_result(tool_call_id="c1", content="file contents here", name="read_file")
        assert msg.role == "tool"
        assert msg.tool_call_id == "c1"
        assert msg.name == "read_file"

    def test_updated_at_changes(self) -> None:
        s = SessionState()
        t0 = s.updated_at
        s.append_user("msg")
        assert s.updated_at >= t0


# ---------------------------------------------------------------------------
# SessionState — to_openai_messages
# ---------------------------------------------------------------------------

class TestToOpenAIMessages:
    def test_system_prompt_included(self) -> None:
        s = SessionState(system_prompt="Be helpful.")
        s.append_user("Hi")
        msgs = s.to_openai_messages()
        assert msgs[0] == {"role": "system", "content": "Be helpful."}
        assert msgs[1] == {"role": "user", "content": "Hi"}

    def test_no_system_prompt_if_empty(self) -> None:
        s = SessionState()
        s.append_user("Hi")
        msgs = s.to_openai_messages()
        assert len(msgs) == 1
        assert msgs[0]["role"] == "user"

    def test_assistant_tool_calls_formatted(self) -> None:
        s = SessionState()
        tc = ToolCall(id="c1", name="ls", arguments={"path": "."})
        s.append_assistant("", tool_calls=[tc])
        msgs = s.to_openai_messages()
        assert msgs[0]["role"] == "assistant"
        assert msgs[0]["content"] == ""
        assert len(msgs[0]["tool_calls"]) == 1
        tc_dict = msgs[0]["tool_calls"][0]
        assert tc_dict["id"] == "c1"
        assert tc_dict["type"] == "function"
        assert tc_dict["function"]["name"] == "ls"
        assert json.loads(tc_dict["function"]["arguments"]) == {"path": "."}

    def test_tool_result_message(self) -> None:
        s = SessionState()
        s.append_tool_result(tool_call_id="c1", content="ok", name="ls")
        msgs = s.to_openai_messages()
        assert msgs[0]["role"] == "tool"
        assert msgs[0]["tool_call_id"] == "c1"
        assert msgs[0]["name"] == "ls"
        assert msgs[0]["content"] == "ok"

    def test_full_round_trip_openai_format(self) -> None:
        """User → assistant (tool call) → tool result → assistant (final)."""
        s = SessionState(system_prompt="System.")
        s.append_user("Read file")
        tc = ToolCall(id="call_1", name="read_file", arguments={"path": "x.py"})
        s.append_assistant("", tool_calls=[tc])
        s.append_tool_result(tool_call_id="call_1", content="file contents")
        s.append_assistant("The file says: file contents")

        msgs = s.to_openai_messages()
        roles = [m["role"] for m in msgs]
        assert roles == ["system", "user", "assistant", "tool", "assistant"]

        # Tool call message has tool_calls array
        assert "tool_calls" in msgs[2]
        # Tool result has tool_call_id
        assert msgs[3]["tool_call_id"] == "call_1"
        # Final assistant has text
        assert "file contents" in msgs[4]["content"]


# ---------------------------------------------------------------------------
# SessionState — JSON round-trip
# ---------------------------------------------------------------------------

class TestJsonRoundTrip:
    def test_empty_session(self) -> None:
        s = SessionState(system_prompt="Hi")
        raw = s.to_json()
        s2 = SessionState.from_json(raw)
        assert s2.system_prompt == "Hi"
        assert s2.messages == []

    def test_multi_turn_with_tools(self) -> None:
        """Build a 4-message conversation, serialize, deserialize, compare."""
        s = SessionState(system_prompt="You are an assistant.")
        s.append_user("Read greeting.txt")
        tc = ToolCall(id="call_abc", name="read_file", arguments={"path": "greeting.txt"})
        s.append_assistant("", tool_calls=[tc], usage=UsageStats(input_tokens=50, output_tokens=10))
        s.append_tool_result(tool_call_id="call_abc", content="Hello, world!")
        s.append_assistant("The file says: Hello, world!", usage=UsageStats(input_tokens=60, output_tokens=15))

        raw = s.to_json()
        s2 = SessionState.from_json(raw)

        # Basic fields
        assert s2.session_id == s.session_id
        assert s2.system_prompt == s.system_prompt
        assert s2.created_at == s.created_at

        # Messages
        assert len(s2.messages) == 4

        # User message
        assert s2.messages[0].role == "user"
        assert s2.messages[0].content == "Read greeting.txt"

        # Assistant with tool calls
        m1 = s2.messages[1]
        assert m1.role == "assistant"
        assert m1.content == ""
        assert len(m1.tool_calls) == 1
        assert m1.tool_calls[0].id == "call_abc"
        assert m1.tool_calls[0].name == "read_file"
        assert m1.tool_calls[0].arguments == {"path": "greeting.txt"}
        assert m1.usage.input_tokens == 50
        assert m1.usage.output_tokens == 10

        # Tool result
        m2 = s2.messages[2]
        assert m2.role == "tool"
        assert m2.tool_call_id == "call_abc"
        assert m2.content == "Hello, world!"

        # Final assistant
        m3 = s2.messages[3]
        assert m3.role == "assistant"
        assert m3.content == "The file says: Hello, world!"
        assert m3.usage.input_tokens == 60

    def test_message_ids_preserved(self) -> None:
        s = SessionState()
        s.append_user("Hi")
        msg_id = s.messages[0].message_id
        s2 = SessionState.from_json(s.to_json())
        assert s2.messages[0].message_id == msg_id

    def test_json_is_human_readable(self) -> None:
        s = SessionState(system_prompt="System prompt")
        s.append_user("Hello")
        s.append_assistant("Hi there!")
        raw = s.to_json()
        parsed = json.loads(raw)
        assert parsed["system_prompt"] == "System prompt"
        assert parsed["messages"][0]["content"] == "Hello"

    def test_unicode_preserved(self) -> None:
        s = SessionState()
        s.append_user("こんにちは世界 🔥")
        s.append_assistant("Response with émojis: 🎉")
        s2 = SessionState.from_json(s.to_json())
        assert s2.messages[0].content == "こんにちは世界 🔥"
        assert s2.messages[1].content == "Response with émojis: 🎉"

    def test_empty_content_preserved(self) -> None:
        s = SessionState()
        tc = ToolCall(id="c1", name="ls", arguments={})
        s.append_assistant("", tool_calls=[tc])
        s2 = SessionState.from_json(s.to_json())
        assert s2.messages[0].content == ""
        assert s2.messages[0].tool_calls[0].name == "ls"


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    def test_session_with_no_messages(self) -> None:
        s = SessionState(system_prompt="Hi")
        msgs = s.to_openai_messages()
        assert msgs == [{"role": "system", "content": "Hi"}]

    def test_from_json_invalid(self) -> None:
        with pytest.raises(json.JSONDecodeError):
            SessionState.from_json("not valid json {{{")

    def test_tool_result_without_name(self) -> None:
        s = SessionState()
        s.append_tool_result(tool_call_id="c1", content="ok")
        s2 = SessionState.from_json(s.to_json())
        assert s2.messages[0].name is None
        # OpenAI format should not include "name" key when None
        wire = s2.to_openai_messages()
        assert "name" not in wire[0]
