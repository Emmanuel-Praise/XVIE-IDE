"""Core data types for xvie-agent — leaf module, no intra-package imports.

Every other phase imports from here, so these types are deliberately frozen,
self-contained, and documented for long-term stability.
"""

from __future__ import annotations

from dataclasses import dataclass, field


# ---------------------------------------------------------------------------
# Token / cost accounting
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class UsageStats:
    """Token usage counters for a single request or an accumulated total.

    Attributes:
        input_tokens: Tokens consumed from the prompt.
        output_tokens: Tokens produced by the model.
        cache_read_tokens: Tokens served from the prompt cache (counts as input).
        cache_write_tokens: Tokens written to the prompt cache (counts as input).

    Computed properties:
        total_tokens: Sum of all four counters.

    Supports ``+`` so callers can accumulate usage across turns:
        >>> UsageStats(10, 5) + UsageStats(20, 3)
        UsageStats(input_tokens=30, output_tokens=8, ...)
    """

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        """Total tokens consumed across input, output, and cache."""
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_write_tokens
        )

    def __add__(self, other: UsageStats) -> UsageStats:
        """Combine two UsageStats into a single sum."""
        if not isinstance(other, UsageStats):
            return NotImplemented
        return UsageStats(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            cache_read_tokens=self.cache_read_tokens + other.cache_read_tokens,
            cache_write_tokens=self.cache_write_tokens + other.cache_write_tokens,
        )


# ---------------------------------------------------------------------------
# Model catalog
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ModelSpec:
    """Describes one model available through any provider.

    Attributes:
        id: Model slug as the provider names it, e.g.
            ``"meta/llama-3.1-8b-instruct"`` (NVIDIA NIM) or
            ``"qwen/qwen3-coder-480b-a35b-instruct"`` (OpenRouter).
        provider: Name that maps to a configured provider — e.g.
            ``"nvidia"``, ``"openrouter"``.  NOT hardcoded to any vendor;
            this is the key that looks up ``FORGE_PROVIDER_<PROVIDER>_API_KEY``
            and ``FORGE_PROVIDER_<PROVIDER>_BASE_URL`` in the environment.
        display_name: Human-friendly label shown in logs / UI.
        context_window: Maximum context length the model accepts.
        supports_tools: ``True`` if the model reliably follows tool-call
            formatting (function-calling / tool_use).
        role_tags: Free-form tags describing the model's strengths, e.g.
            ``("planning", "coding", "fast")``.
    """

    id: str
    provider: str
    display_name: str = ""
    context_window: int = 8192
    supports_tools: bool = False
    supports_reasoning: bool = False
    role_tags: tuple[str, ...] = ()
    plan_compliance: str = "unknown"  # "strong" | "weak" | "unknown"


# ---------------------------------------------------------------------------
# Budget / rate-limit controls
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class BudgetConfig:
    """Per-session budget constraints.

    Every field is optional — ``None`` means unlimited for that dimension.

    Attributes:
        max_total_tokens: Hard cap on cumulative token usage.
        max_total_cost_usd: Hard cap on estimated cost in USD.
        max_tool_calls: Maximum number of tool invocations allowed.
        max_model_calls: Maximum number of LLM requests allowed.
        max_turns: Maximum orchestrator loop iterations.
    """

    max_total_tokens: int | None = None
    max_total_cost_usd: float | None = None
    max_tool_calls: int | None = None
    max_model_calls: int | None = None
    max_turns: int | None = None


# ---------------------------------------------------------------------------
# Tool-call protocol
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ToolCall:
    """A single tool invocation requested by the model.

    Attributes:
        id: Opaque identifier chosen by the model (used to correlate results).
        name: Registered tool name, e.g. ``"read_file"``.
        arguments: Keyword arguments the model passed to the tool.
    """

    id: str
    name: str
    arguments: dict = field(default_factory=dict)


@dataclass(frozen=True)
class ToolResult:
    """Outcome of executing a :class:`ToolCall`.

    Attributes:
        tool_call_id: The ``ToolCall.id`` this result corresponds to.
        ok: ``True`` if the tool completed without error.
        content: Textual output returned by the tool.
        error_kind: Optional category string (e.g. ``"permission_denied"``)
            when ``ok`` is ``False``.
    """

    tool_call_id: str
    ok: bool
    content: str
    error_kind: str | None = None


# ---------------------------------------------------------------------------
# Single-model response
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AssistantTurn:
    """Parsed response from a single model call.

    Returned by :meth:`ProviderClient.complete` and assembled from
    :class:`StreamEvent` chunks during streaming.

    Attributes:
        content: The model's textual reply (may be empty if it only issued
            tool calls).  Never contains raw ``<think>`` tags — reasoning
            is split into the ``reasoning`` field.
        tool_calls: Tool invocations requested by the model.
        usage: Token counters for this single request.
        model: The model slug that actually served the response.
        reasoning: If the model supports visible reasoning, the
            chain-of-thought text extracted from ``reasoning_content``
            or a ``<think>`` block.  ``None`` if the model didn't
            produce reasoning.
        truncated: ``True`` when the provider reported ``finish_reason``
            of ``length`` — output was cut off by the token cap.
        incomplete: ``True`` when a stream ended without a normal terminal
            signal, distinct from a provider-reported token limit.
    """

    content: str
    tool_calls: tuple[ToolCall, ...] = ()
    usage: UsageStats = field(default_factory=UsageStats)
    model: str = ""
    reasoning: str | None = None
    truncated: bool = False
    incomplete: bool = False


@dataclass(frozen=True)
class StreamEvent:
    """One chunk yielded by the streaming response iterator.

    Exactly one of the data fields will be populated per event.

    Attributes:
        text_delta: Incremental text content (may be empty string).
        reasoning_delta: Incremental reasoning/thinking text.
        tool_call: A complete tool call parsed from the stream.
        usage: Token counters, typically only present on the final event.
        done: ``True`` on the terminal event after all data has been sent.
        truncated: ``True`` when the stream ended with ``finish_reason``
            of ``length`` — output was cut off by the token cap.
        incomplete: ``True`` when the stream ended without a normal terminal
            signal, distinct from a provider-reported token limit.
    """

    text_delta: str = ""
    reasoning_delta: str = ""
    tool_call: ToolCall | None = None
    usage: UsageStats | None = None
    done: bool = False
    truncated: bool = False
    incomplete: bool = False


@dataclass(frozen=True)
class AgentEvent:
    """A safe, user-visible progress update emitted during an agent run."""

    kind: str
    message: str
    data: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Clarifying questions (ask_question tool)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class QuestionOption:
    """One suggested answer chip shown to the user."""

    label: str
    description: str = ""


@dataclass(frozen=True)
class AgentQuestion:
    """A single clarifying question from the model.

    Attributes:
        id: Stable id chosen by the model (used to correlate answers).
        question: The question text.
        header: Short label shown above the question (e.g. "Scope").
        options: Suggested answer chips (2-4 recommended, max 5).
        allow_custom: When True the UI also shows a free-text box.
    """

    id: str
    question: str
    header: str = ""
    options: tuple[QuestionOption, ...] = ()
    allow_custom: bool = True


@dataclass(frozen=True)
class QuestionAnswer:
    """The user's answer to one :class:`AgentQuestion`."""

    id: str
    selected: tuple[str, ...] = ()
    custom_text: str = ""


# ---------------------------------------------------------------------------
# Top-level run result
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AgentRunResult:
    """Immutable snapshot returned when the agent loop finishes.

    Attributes:
        final_output: The model's last textual response.
        turns: Total orchestrator iterations executed.
        tool_calls: All tool calls issued during the run.
        usage: Aggregated token usage across the entire run.
        stop_reason: Machine-readable termination cause, e.g.
            ``"completed"``, ``"budget_exceeded"``, ``"max_turns"``.
        transcript: Ordered list of dicts representing the full
            conversation history (suitable for serialization).
        model_calls_by_model: Per-model call counts, e.g.
            ``{"llama-3.3-70b": 5, "deepseek-r1": 2}``.
    """

    final_output: str
    turns: int
    tool_calls: tuple[ToolCall, ...]
    usage: UsageStats
    stop_reason: str
    transcript: tuple[dict, ...] = ()
    model_calls_by_model: dict[str, int] = field(default_factory=dict)
    reasoning: str | None = None
    activity: tuple[AgentEvent, ...] = ()
    selected_model: str = ""
    confirmation_required: bool = False
    verification_outcome: str | None = None
    timings: dict[str, float] = field(default_factory=dict)
    session_id: str = ""
    pending_questions: tuple[AgentQuestion, ...] = ()
