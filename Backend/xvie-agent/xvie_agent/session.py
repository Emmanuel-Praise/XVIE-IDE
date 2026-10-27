"""Serializable session state for xvie-agent.

Provides a clean, JSON-safe conversation state that can be:
  * Sent to the model on every turn (via ``to_openai_messages()``)
  * Saved to disk for resume (via ``to_json()`` / ``from_json()``)

Design decisions:
  * ``AgentMessage`` is **mutable** (unlike most types in ``types.py``)
    because sessions grow by appending messages.
  * ``message_id`` is a UUID for deduplication and correlation.
  * Timestamps are ISO-8601 strings in JSON for human readability.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from xvie_agent.token_budget import estimate_tokens
from xvie_agent.types import ToolCall, UsageStats


# ---------------------------------------------------------------------------
# Message
# ---------------------------------------------------------------------------

@dataclass
class AgentMessage:
    """A single message in the conversation history.

    Attributes:
        role: One of ``"system"``, ``"user"``, ``"assistant"``, ``"tool"``.
        content: Textual content (may be empty for assistant messages that
            only issue tool calls).
        tool_calls: Tool invocations requested by the model (only on
            ``role="assistant"`` messages).
        tool_call_id: Correlates a ``role="tool"`` message back to the
            ``ToolCall.id`` that produced it.
        name: Optional tool name for ``role="tool"`` messages.
        message_id: Stable UUID for deduplication.
        usage: Token counters captured when this message was generated
            (typically only on ``role="assistant"`` messages).
    """

    role: str
    content: str = ""
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None
    name: str | None = None
    message_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    usage: UsageStats | None = None
    reasoning: str | None = None


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------

@dataclass
class SessionState:
    """Full conversation state — serializable to JSON and back.

    Attributes:
        session_id: Stable UUID for this session.
        system_prompt: The system prompt (prepended on every model call).
        messages: Ordered conversation history.
        created_at: ISO-8601 creation timestamp.
        updated_at: ISO-8601 last-updated timestamp.
    """

    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    system_prompt: str = ""
    messages: list[AgentMessage] = field(default_factory=list)
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    execution_state: dict[str, Any] | None = None
    context_summary: str = ""
    parent_session_id: str | None = None
    visible_thoughts: list[dict[str, Any]] = field(default_factory=list)

    # -- Convenience appenders ------------------------------------------------

    def append_user(self, text: str) -> AgentMessage:
        """Append a user message and return it."""
        msg = AgentMessage(role="user", content=text)
        self.messages.append(msg)
        self._touch()
        return msg

    def append_assistant(
        self,
        content: str,
        tool_calls: list[ToolCall] | None = None,
        usage: UsageStats | None = None,
        reasoning: str | None = None,
    ) -> AgentMessage:
        """Append an assistant message (text and/or tool calls)."""
        msg = AgentMessage(role="assistant", content=content, tool_calls=tool_calls, usage=usage, reasoning=reasoning)
        self.messages.append(msg)
        self._touch()
        return msg

    def append_tool_result(
        self,
        tool_call_id: str,
        content: str,
        name: str | None = None,
    ) -> AgentMessage:
        """Append a tool-result message correlated to a tool call."""
        msg = AgentMessage(role="tool", content=content, tool_call_id=tool_call_id, name=name)
        self.messages.append(msg)
        self._touch()
        return msg

    # -- OpenAI wire format ---------------------------------------------------

    def to_openai_messages(self) -> list[dict]:
        """Convert to the ``list[dict]`` format expected by the model API.

        The system prompt is included as the first message.  Tool-call
        information is formatted exactly as OpenAI's function-calling
        protocol expects.
        """
        out: list[dict] = []
        if self.system_prompt:
            out.append({"role": "system", "content": self.system_prompt})

        if self.context_summary:
            out.append({
                "role": "user",
                "content": "<previous-session-summary>\n" + self.context_summary + "\n</previous-session-summary>",
            })

        for msg in self.messages:
            d: dict[str, Any] = {"role": msg.role}

            # Content
            if msg.content:
                d["content"] = msg.content
            elif msg.role == "assistant":
                d["content"] = ""

            # Tool calls on assistant messages
            if msg.tool_calls:
                d["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": json.dumps(tc.arguments),
                        },
                    }
                    for tc in msg.tool_calls
                ]
            if msg.reasoning and msg.role == "assistant":
                d["reasoning_content"] = msg.reasoning

            # Tool result correlation
            if msg.tool_call_id:
                d["tool_call_id"] = msg.tool_call_id
            if msg.name:
                d["name"] = msg.name

            out.append(d)
        return out

    def compact_for_resume(self, keep_last_n_turns: int = 4) -> bool:
        """Replace old active history with a deterministic summary.

        The store archives the complete session before calling this method.
        Returns True when history was compacted.
        """
        user_starts = [i for i, msg in enumerate(self.messages) if msg.role == "user"]
        if len(user_starts) <= keep_last_n_turns:
            return False

        cutoff = user_starts[-keep_last_n_turns]
        older = self.messages[:cutoff]
        lines: list[str] = []
        for msg in older:
            text = (msg.content or "").strip()
            if msg.role == "user" and text:
                lines.append("User request: " + text[:700])
            elif msg.role == "assistant" and text:
                lines.append("Progress: " + text[:500])
            elif msg.role == "assistant" and msg.tool_calls:
                names = ", ".join(call.name for call in msg.tool_calls)
                if names:
                    lines.append("Actions taken: " + names[:300])
        lines = list(dict.fromkeys(lines))[-18:]
        if self.execution_state:
            changed = self.execution_state.get("changed_files", [])
            if changed:
                lines.append("Changed files: " + ", ".join(map(str, changed))[:700])
            outcome = self.execution_state.get("final_outcome")
            if outcome:
                lines.append("Last workflow status: " + str(outcome)[:200])
        summary = "\n".join("- " + line for line in lines)
        if self.context_summary:
            summary = "- Earlier compacted context: " + self.context_summary[:2500] + ("\n" + summary if summary else "")
        if not summary:
            summary = "Earlier conversation was archived. Continue from the recent turns and inspect files when exact details are needed."
        self.context_summary = summary[:6000]
        self.messages = self.messages[cutoff:]
        self._touch()
        return True

    def summary_for_fresh_context(self) -> str:
        """Summarize earlier turns for a linked fresh session."""
        last_user = max((i for i, msg in enumerate(self.messages) if msg.role == "user"), default=len(self.messages))
        lines: list[str] = []
        for msg in self.messages[:last_user]:
            text = (msg.content or "").strip()
            if msg.role == "user" and text:
                lines.append("Earlier request: " + text[:600])
            elif msg.role == "assistant" and text:
                lines.append("Progress: " + text[:400])
            elif msg.role == "assistant" and msg.tool_calls:
                names = ", ".join(call.name for call in msg.tool_calls)
                if names:
                    lines.append("Actions taken: " + names[:250])
        lines = list(dict.fromkeys(lines))[-14:]
        if self.execution_state:
            changed = self.execution_state.get("changed_files", [])
            if changed:
                lines.append("Changed files: " + ", ".join(map(str, changed))[:600])
            outcome = self.execution_state.get("final_outcome")
            if outcome:
                lines.append("Last workflow status: " + str(outcome)[:160])
        return "\n".join("- " + line for line in lines)[:4000]

    # -- JSON serialization ---------------------------------------------------

    def to_json(self, indent: int = 2) -> str:
        """Serialize the session to a JSON string."""
        return json.dumps(self._to_dict(), indent=indent, ensure_ascii=False)

    @classmethod
    def from_json(cls, raw: str) -> SessionState:
        """Deserialize a session from a JSON string."""
        data = json.loads(raw)
        return cls._from_dict(data)

    # -- Tombstoning ----------------------------------------------------------

    def tombstone_oldest_tool_results(self, keep_last_n_turns: int = 4) -> None:
        """Replace old tool-result content with a placeholder.

        Keeps the last *keep_last_n_turns* user/assistant pairs fully intact.
        Older ``role="tool"`` messages have their content replaced with a
        one-line placeholder noting the original size.

        This mutates the session in place.
        """
        # Find the boundaries of each turn (user message → next user message)
        turn_starts: list[int] = []
        for i, msg in enumerate(self.messages):
            if msg.role == "user":
                turn_starts.append(i)

        if len(turn_starts) <= keep_last_n_turns:
            return  # Nothing to tombstone

        # The cutoff index: everything before this is old
        cutoff = turn_starts[len(turn_starts) - keep_last_n_turns]

        for msg in self.messages[:cutoff]:
            if msg.role == "tool" and msg.content and not msg.content.startswith("[tool result omitted"):
                original_len = len(msg.content)
                msg.content = f"[tool result omitted, {original_len} chars]"
        self.context_summary = "Older tool output was compacted; inspect files again if exact details are needed."
        self._touch()

    # -- Internals ------------------------------------------------------------

    def _touch(self) -> None:
        self.updated_at = datetime.now(timezone.utc).isoformat()

    def _to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "system_prompt": self.system_prompt,
            "messages": [self._msg_to_dict(m) for m in self.messages],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "execution_state": self.execution_state,
            "context_summary": self.context_summary,
            "parent_session_id": self.parent_session_id,
            "visible_thoughts": self.visible_thoughts,
        }

    @staticmethod
    def _msg_to_dict(msg: AgentMessage) -> dict:
        d: dict[str, Any] = {
            "role": msg.role,
            "content": msg.content,
            "message_id": msg.message_id,
        }
        if msg.tool_calls:
            d["tool_calls"] = [
                {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                for tc in msg.tool_calls
            ]
        if msg.tool_call_id is not None:
            d["tool_call_id"] = msg.tool_call_id
        if msg.name is not None:
            d["name"] = msg.name
        if msg.usage is not None:
            d["usage"] = {
                "input_tokens": msg.usage.input_tokens,
                "output_tokens": msg.usage.output_tokens,
                "cache_read_tokens": msg.usage.cache_read_tokens,
                "cache_write_tokens": msg.usage.cache_write_tokens,
            }
        if msg.reasoning is not None:
            d["reasoning"] = msg.reasoning
        return d

    @classmethod
    def _from_dict(cls, data: dict) -> SessionState:
        messages = [
            cls._msg_from_dict(m) for m in data.get("messages", [])
        ]
        return cls(
            session_id=data.get("session_id", str(uuid.uuid4())),
            system_prompt=data.get("system_prompt", ""),
            messages=messages,
            created_at=data.get("created_at", ""),
            updated_at=data.get("updated_at", ""),
            execution_state=data.get("execution_state"),
            context_summary=data.get("context_summary", ""),
            parent_session_id=data.get("parent_session_id"),
            visible_thoughts=data.get("visible_thoughts", []),
        )

    @staticmethod
    def _msg_from_dict(d: dict) -> AgentMessage:
        tool_calls = None
        if "tool_calls" in d:
            tool_calls = [
                ToolCall(id=tc["id"], name=tc["name"], arguments=tc.get("arguments", {}))
                for tc in d["tool_calls"]
            ]
        usage = None
        if "usage" in d:
            u = d["usage"]
            usage = UsageStats(
                input_tokens=u.get("input_tokens", 0),
                output_tokens=u.get("output_tokens", 0),
                cache_read_tokens=u.get("cache_read_tokens", 0),
                cache_write_tokens=u.get("cache_write_tokens", 0),
            )
        return AgentMessage(
            role=d.get("role", "user"),
            content=d.get("content", ""),
            tool_calls=tool_calls,
            tool_call_id=d.get("tool_call_id"),
            name=d.get("name"),
            message_id=d.get("message_id", str(uuid.uuid4())),
            usage=usage,
            reasoning=d.get("reasoning"),
        )
