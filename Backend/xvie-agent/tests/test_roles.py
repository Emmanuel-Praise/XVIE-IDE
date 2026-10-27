"""Tests for Phase 15 — capability-based model roles."""

from __future__ import annotations

from pathlib import Path

import pytest

from xvie_agent.router import (
    ModelRouter,
    RoutingPolicy,
    RoleConfig,
    classify_task,
    load_routing_config,
)
from xvie_agent.types import ModelSpec


# ---------------------------------------------------------------------------
# classify_task — extended signals
# ---------------------------------------------------------------------------


class TestClassifyExtended:
    def test_ui_design_trigger(self):
        assert classify_task("Build me a pricing page component") == "ui_design"

    def test_ui_dashboard(self):
        assert classify_task("Create a dashboard layout") == "ui_design"

    def test_ui_landing_page(self):
        assert classify_task("Design a landing page") == "ui_design"

    def test_ui_with_coding_verb_stays_coding(self):
        """UI word + coding verb + file ref -> coding (more specific)."""
        assert classify_task("Fix the button in component.py") == "coding"

    def test_reasoning_trigger(self):
        assert classify_task("Think about the trade-offs of this approach") == "reasoning"

    def test_reasoning_analyze(self):
        assert classify_task("Analyze the performance bottlenecks") == "reasoning"

    def test_reasoning_with_coding_stays_coding(self):
        """Reasoning word + coding verb -> coding (more specific)."""
        assert classify_task("Consider and fix the memory leak in app.py") == "coding"

    def test_existing_signals_still_work(self):
        assert classify_task("What does config.py do?") == "planning"
        assert classify_task("Fix the bug in main.py") == "coding"
        assert classify_task("run tests", turn_number=1) == "fast_edit"


# ---------------------------------------------------------------------------
# Role config — requires validation
# ---------------------------------------------------------------------------


class TestRoleRequires:
    def test_valid_config_loads(self, tmp_path: Path):
        """A valid roles config loads without error."""
        yaml_content = """
roles:
  reasoning:
    requires:
      supports_reasoning: true
    temperature: 0.3
    models:
      - provider: nvidia
        id: "deepseek-r1"
        context_window: 131072
        supports_reasoning: true
lanes:
  reasoning: reasoning
"""
        config_file = tmp_path / "routing.yaml"
        config_file.write_text(yaml_content)
        policy = load_routing_config(config_file)
        specs, role_config = policy.resolve_lane("reasoning")
        assert len(specs) == 1
        assert specs[0].supports_reasoning is True
        assert role_config.temperature == 0.3

    def test_invalid_requires_raises(self, tmp_path: Path):
        """A model that doesn't satisfy requires raises ValueError at load time."""
        yaml_content = """
roles:
  reasoning:
    requires:
      supports_reasoning: true
    models:
      - provider: nvidia
        id: "llama-8b"
        context_window: 131072
        supports_reasoning: false
"""
        config_file = tmp_path / "routing.yaml"
        config_file.write_text(yaml_content)
        with pytest.raises(ValueError, match="does not satisfy"):
            load_routing_config(config_file)

    def test_role_config_temperature(self, tmp_path: Path):
        """Role temperature is stored and accessible."""
        yaml_content = """
roles:
  coding:
    temperature: 0.0
    max_tokens: 2000
    models:
      - provider: nvidia
        id: "llama"
        context_window: 131072
lanes:
  coding: coding
"""
        config_file = tmp_path / "routing.yaml"
        config_file.write_text(yaml_content)
        policy = load_routing_config(config_file)
        _, role_config = policy.resolve_lane("coding")
        assert role_config.temperature == 0.0
        assert role_config.max_tokens == 2000

    def test_lane_alias_resolves(self, tmp_path: Path):
        """Lane aliases map to the correct role."""
        yaml_content = """
roles:
  my_coding_role:
    temperature: 0.0
    models:
      - provider: nvidia
        id: "llama"
        context_window: 131072
lanes:
  coding: my_coding_role
"""
        config_file = tmp_path / "routing.yaml"
        config_file.write_text(yaml_content)
        policy = load_routing_config(config_file)
        specs, _ = policy.resolve_lane("coding")
        assert len(specs) == 1
        assert specs[0].id == "llama"


# ---------------------------------------------------------------------------
# Temperature/max_tokens threading
# ---------------------------------------------------------------------------


class TestRoleTemperatureThreading:
    def test_router_uses_role_temperature(self):
        """The router passes role temperature to the provider call."""
        from unittest.mock import MagicMock

        mock_client = MagicMock()
        mock_client.provider_name = "nvidia"
        mock_client.complete.return_value = MagicMock(
            content="ok",
            tool_calls=(),
            usage=MagicMock(input_tokens=10, output_tokens=5, cache_read_tokens=0, cache_write_tokens=0, total_tokens=15),
            model="llama",
            reasoning=None,
        )

        policy = RoutingPolicy(
            lanes={
                "coding": (ModelSpec(id="llama", provider="nvidia"),),
            },
            role_configs={
                "coding": RoleConfig(temperature=0.7, max_tokens=500),
            },
        )
        router = ModelRouter(providers={"nvidia": mock_client}, policy=policy)
        router.complete_with_fallback("coding", [{"role": "user", "content": "hi"}])

        # Verify temperature and max_tokens were passed
        call_kwargs = mock_client.complete.call_args
        assert call_kwargs.kwargs.get("temperature") == 0.7 or call_kwargs[1].get("temperature") == 0.7
        assert call_kwargs.kwargs.get("max_tokens") == 500 or call_kwargs[1].get("max_tokens") == 500


# ---------------------------------------------------------------------------
# Config loading — roles format
# ---------------------------------------------------------------------------


class TestRolesConfigFormat:
    def test_full_roles_config(self, tmp_path: Path):
        """Load a complete roles-based routing.yaml."""
        yaml_content = """
roles:
  reasoning:
    requires:
      supports_reasoning: true
    temperature: 0.3
    max_tokens: 3000
    models:
      - provider: nvidia
        id: "deepseek-r1"
        context_window: 131072
        supports_reasoning: true
        supports_tools: true
  coding:
    temperature: 0.0
    max_tokens: 2000
    models:
      - provider: nvidia
        id: "llama-70b"
        context_window: 131072
        supports_tools: true
  fast_edit:
    temperature: 0.0
    max_tokens: 600
    models:
      - provider: nvidia
        id: "llama-8b"
        context_window: 131072
        supports_tools: true
lanes:
  reasoning: reasoning
  coding: coding
  fast_edit: fast_edit
"""
        config_file = tmp_path / "routing.yaml"
        config_file.write_text(yaml_content)
        policy = load_routing_config(config_file)

        assert set(policy.lanes.keys()) == {"reasoning", "coding", "fast_edit"}
        assert set(policy.role_configs.keys()) == {"reasoning", "coding", "fast_edit"}
        assert policy.role_configs["reasoning"].temperature == 0.3
        assert policy.role_configs["coding"].max_tokens == 2000
        assert policy.role_configs["fast_edit"].max_tokens == 600
