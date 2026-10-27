"""Tests for xvie_agent.types — construction, computed props, and __add__."""

import pytest

from xvie_agent.types import (
    AgentRunResult,
    BudgetConfig,
    ModelSpec,
    ToolCall,
    ToolResult,
    UsageStats,
)


# ------------------------------------------------------------------ UsageStats

class TestUsageStats:
    def test_default_construction(self) -> None:
        u = UsageStats()
        assert u.input_tokens == 0
        assert u.output_tokens == 0
        assert u.cache_read_tokens == 0
        assert u.cache_write_tokens == 0

    def test_total_tokens_property(self) -> None:
        u = UsageStats(input_tokens=10, output_tokens=5, cache_read_tokens=3, cache_write_tokens=2)
        assert u.total_tokens == 20

    def test_total_tokens_with_zeros(self) -> None:
        u = UsageStats(input_tokens=42)
        assert u.total_tokens == 42

    def test_add_combines_all_fields(self) -> None:
        a = UsageStats(input_tokens=10, output_tokens=5, cache_read_tokens=1, cache_write_tokens=2)
        b = UsageStats(input_tokens=20, output_tokens=3, cache_read_tokens=0, cache_write_tokens=4)
        result = a + b
        assert result.input_tokens == 30
        assert result.output_tokens == 8
        assert result.cache_read_tokens == 1
        assert result.cache_write_tokens == 6
        assert result.total_tokens == 45

    def test_add_with_zero(self) -> None:
        a = UsageStats(input_tokens=7, output_tokens=3)
        result = a + UsageStats()
        assert result.input_tokens == 7
        assert result.output_tokens == 3
        assert result.total_tokens == 10

    def test_add_returns_not_implemented_for_non_usage(self) -> None:
        u = UsageStats(input_tokens=1)
        assert u.__add__("not a usage stats") is NotImplemented

    def test_add_chain(self) -> None:
        total = UsageStats()
        for _ in range(5):
            total = total + UsageStats(input_tokens=10, output_tokens=2)
        assert total.input_tokens == 50
        assert total.output_tokens == 10
        assert total.total_tokens == 60

    def test_frozen(self) -> None:
        u = UsageStats(input_tokens=1)
        with pytest.raises(AttributeError):
            u.input_tokens = 2  # type: ignore[misc]


# ------------------------------------------------------------------- ModelSpec

class TestModelSpec:
    def test_construct_nvidia_model(self) -> None:
        spec = ModelSpec(
            id="meta/llama-3.1-8b-instruct",
            provider="nvidia",
            display_name="Llama 3.1 8B (NVIDIA NIM)",
            context_window=131072,
            supports_tools=True,
            role_tags=("coding", "analysis", "fast"),
        )
        assert spec.id == "meta/llama-3.1-8b-instruct"
        assert spec.provider == "nvidia"
        assert spec.context_window == 131072
        assert spec.supports_tools is True
        assert "coding" in spec.role_tags

    def test_construct_placeholder_provider(self) -> None:
        """Verify ModelSpec works with any provider string."""
        spec = ModelSpec(
            id="whatever/model-name",
            provider="some_future_provider",
            display_name="Future Model",
        )
        assert spec.provider == "some_future_provider"

    def test_defaults(self) -> None:
        spec = ModelSpec(id="test/model", provider="test")
        assert spec.context_window == 8192
        assert spec.supports_tools is False
        assert spec.role_tags == ()

    def test_role_tags_are_tuple(self) -> None:
        spec = ModelSpec(id="m", provider="p", display_name="M", role_tags=("fast",))
        assert isinstance(spec.role_tags, tuple)

    def test_frozen(self) -> None:
        spec = ModelSpec(id="m", provider="p", display_name="M")
        with pytest.raises(AttributeError):
            spec.provider = "other"  # type: ignore[misc]


# ----------------------------------------------------------------- BudgetConfig

class TestBudgetConfig:
    def test_all_none(self) -> None:
        b = BudgetConfig()
        assert b.max_total_tokens is None
        assert b.max_total_cost_usd is None
        assert b.max_tool_calls is None
        assert b.max_model_calls is None
        assert b.max_turns is None

    def test_partial_config(self) -> None:
        b = BudgetConfig(max_turns=10, max_total_tokens=50000)
        assert b.max_turns == 10
        assert b.max_total_tokens == 50000
        assert b.max_total_cost_usd is None

    def test_frozen(self) -> None:
        b = BudgetConfig(max_turns=5)
        with pytest.raises(AttributeError):
            b.max_turns = 10  # type: ignore[misc]


# -------------------------------------------------------------------- ToolCall

class TestToolCall:
    def test_construction(self) -> None:
        tc = ToolCall(id="call_1", name="read_file", arguments={"path": "foo.py"})
        assert tc.id == "call_1"
        assert tc.name == "read_file"
        assert tc.arguments == {"path": "foo.py"}

    def test_empty_arguments(self) -> None:
        tc = ToolCall(id="c", name="ls")
        assert tc.arguments == {}

    def test_frozen(self) -> None:
        tc = ToolCall(id="c", name="ls")
        with pytest.raises(AttributeError):
            tc.name = "rm"  # type: ignore[misc]


# ------------------------------------------------------------------- ToolResult

class TestToolResult:
    def test_success(self) -> None:
        tr = ToolResult(tool_call_id="call_1", ok=True, content="file contents here")
        assert tr.ok is True
        assert tr.error_kind is None

    def test_failure(self) -> None:
        tr = ToolResult(
            tool_call_id="call_2", ok=False, content="", error_kind="permission_denied"
        )
        assert tr.ok is False
        assert tr.error_kind == "permission_denied"

    def test_frozen(self) -> None:
        tr = ToolResult(tool_call_id="c", ok=True, content="")
        with pytest.raises(AttributeError):
            tr.ok = False  # type: ignore[misc]


# --------------------------------------------------------------- AgentRunResult

class TestAgentRunResult:
    def test_construction(self) -> None:
        usage = UsageStats(input_tokens=100, output_tokens=50)
        tc = ToolCall(id="c1", name="write_file", arguments={"path": "x.py", "content": "..."})
        tr = ToolResult(tool_call_id="c1", ok=True, content="written")
        result = AgentRunResult(
            final_output="Done.",
            turns=3,
            tool_calls=(tc,),
            usage=usage,
            stop_reason="completed",
            transcript=({"role": "user", "content": "hi"},),
            model_calls_by_model={"llama-3.3-70b": 2, "deepseek-r1": 1},
        )
        assert result.final_output == "Done."
        assert result.turns == 3
        assert len(result.tool_calls) == 1
        assert result.usage.total_tokens == 150
        assert result.stop_reason == "completed"
        assert len(result.transcript) == 1
        assert result.model_calls_by_model["llama-3.3-70b"] == 2

    def test_defaults(self) -> None:
        result = AgentRunResult(
            final_output="ok", turns=1, tool_calls=(), usage=UsageStats(), stop_reason="completed"
        )
        assert result.transcript == ()
        assert result.model_calls_by_model == {}

    def test_frozen(self) -> None:
        result = AgentRunResult(
            final_output="x", turns=1, tool_calls=(), usage=UsageStats(), stop_reason="done"
        )
        with pytest.raises(AttributeError):
            result.turns = 5  # type: ignore[misc]
