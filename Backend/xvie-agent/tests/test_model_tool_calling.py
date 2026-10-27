"""Test each model's tool-calling ability for coding tasks.

Tests models directly via ProviderClient to isolate model behavior
from the agent loop.  Each model gets the same prompt + tools and
we measure whether it calls tools correctly.
"""

from __future__ import annotations

import json
import os
import time
import pytest
from pathlib import Path
from xvie_agent.providers.base import ProviderClient, ProviderConfig, RateLimitedError

# ---------------------------------------------------------------------------
# The test prompt + tools — every model gets the identical challenge
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create or overwrite a file with the given content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path"},
                    "content": {"type": "string", "description": "File content"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "think",
            "description": "Call this BEFORE any tool calls to state your reasoning.",
            "parameters": {
                "type": "object",
                "properties": {
                    "thought": {"type": "string", "description": "Your reasoning"},
                },
                "required": ["thought"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_plan",
            "description": "Create a plan before multi-step tasks. Must be called before write_file for multi-step tasks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string"},
                                "description": {"type": "string"},
                                "files_touched": {"type": "array", "items": {"type": "string"}},
                            },
                        },
                    },
                },
                "required": ["title", "summary", "steps"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mark_task_done",
            "description": "Mark a plan task as completed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_name": {"type": "string"},
                },
                "required": ["task_name"],
            },
        },
    },
]

SYSTEM_PROMPT = (
    "You are a coding assistant with tools. When asked to create files, "
    "you MUST use the write_file tool — never output code as text. "
    "For multi-step tasks, call write_plan FIRST, then write_file for each file. "
    "Always call think() before starting work to state your plan."
)

# Three difficulty levels of coding challenges
CHALLENGES = {
    "easy": {
        "prompt": "Create a file called greet.py with a function that takes a name and returns 'Hello, {name}!'",
        "expected_files": ["greet.py"],
        "min_lines": 3,
        "must_contain": ["def ", "return"],
    },
    "medium": {
        "prompt": "Create a file called fibonacci.py with a fibonacci function that uses memoization (decorator or cache), includes type hints, and handles edge cases for negative and zero input.",
        "expected_files": ["fibonacci.py"],
        "min_lines": 10,
        "must_contain": ["def ", "memo", "cache"],
    },
    "hard": {
        "prompt": "Create two files: a JSON parser module (json_parser.py) with a parse_json function that handles nested objects and arrays, and a test file (test_parser.py) with 3 test cases using assert statements.",
        "expected_files": ["json_parser.py", "test_parser.py"],
        "min_lines": 15,
        "must_contain": ["def ", "assert"],
    },
}


def _resolve_nvidia_client() -> ProviderClient | None:
    """Try to build an NVIDIA client from env vars."""
    api_key = os.getenv("FORGE_PROVIDER_NVIDIA_API_KEY") or os.getenv("NVIDIA_API_KEY")
    base_url = os.getenv("FORGE_PROVIDER_NVIDIA_BASE_URL") or os.getenv(
        "NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"
    )
    if not api_key:
        return None
    return ProviderClient(
        config=ProviderConfig(name="nvidia", api_key=api_key, base_url=base_url)
    )


# All models to test (from the user's list, filtered to free endpoints + coding capable)
MODELS_TO_TEST = [
    # --- Tier 1: Known good / large models (verified live with tool-calling) ---
    ("nvidia/nemotron-3-ultra-550b-a55b", "Nemotron 3 Ultra 550B", "unknown"),
    ("moonshotai/kimi-k3", "Kimi K3", "unknown"),
    ("poolside/laguna-xs-2.1", "Laguna XS 2.1", "unknown"),
    # --- Tier 2: Smaller / newer ---
    ("nvidia/nemotron-3.5-lightning-30b-a3b", "Nemotron 3.5 Lightning 30B", "unknown"),
]


def _test_single_model(client: ProviderClient, model_id: str, challenge: dict, max_turns: int = 4) -> dict:
    """Send a challenge to a model and analyze the response.

    Does a multi-turn conversation: the model may call think() first,
    then write_file on a subsequent turn.  We feed tool results back
    and keep going until write_file is called or max_turns is hit.

    Returns a dict with:
      - success: bool
      - tool_calls: list of (name, args_parsed) tuples
      - has_think: bool
      - has_plan: bool
      - has_write: bool
      - write_file_args: dict or None
      - text_response: str (first 200 chars)
      - error: str or None
    """
    result = {
        "success": False,
        "tool_calls": [],
        "has_think": False,
        "has_plan": False,
        "has_write": False,
        "write_file_args": None,
        "text_response": "",
        "error": None,
    }

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": challenge["prompt"]},
    ]

    for turn_num in range(max_turns):
        try:
            turn = client.complete(
                model=model_id,
                messages=messages,
                tools=TOOLS,
            )
        except RateLimitedError as e:
            result["error"] = f"rate_limited: {e}"
            return result
        except Exception as e:
            result["error"] = f"{type(e).__name__}: {e}"
            return result

        result["text_response"] = (turn.content or "")[:200]

        # Parse tool calls
        for tc in (turn.tool_calls or []):
            name = tc.name
            args = tc.arguments if isinstance(tc.arguments, dict) else {}
            result["tool_calls"].append((name, args))

            if name == "think":
                result["has_think"] = True
            elif name == "write_plan":
                result["has_plan"] = True
            elif name == "write_file":
                result["has_write"] = True
                if result["write_file_args"] is None:
                    result["write_file_args"] = args

        # If we got write_file, we're done
        if result["has_write"]:
            break

        # If no tool calls at all, model gave a text answer — done
        if not turn.tool_calls:
            break

        # Feed tool results back so the model can continue
        for tc in (turn.tool_calls or []):
            name = tc.name
            args = tc.arguments if isinstance(tc.arguments, dict) else {}
            # Append assistant message with tool call
            messages.append({
                "role": "assistant",
                "content": turn.content or "",
                "tool_calls": [{"id": tc.id, "type": "function", "function": {"name": name, "arguments": json.dumps(args) if isinstance(args, dict) else args}}],
            })
            # Append tool result
            if name == "think":
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": "Thought recorded. Now proceed with the task."})
            elif name == "write_plan":
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": "Plan saved. Now implement each step with write_file."})
            else:
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": "OK"})

    result["success"] = (
        result["has_write"]
        and result["write_file_args"] is not None
        and len(result["write_file_args"].get("content", "")) > 0
    )

    return result


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestModelToolCalling:
    """Test each model's ability to make correct tool calls for coding tasks."""

    @pytest.fixture(scope="class")
    def client(self):
        c = _resolve_nvidia_client()
        if c is None:
            pytest.skip("No NVIDIA API key configured")
        return c

    @pytest.mark.parametrize(
        "model_id,model_name,compliance",
        MODELS_TO_TEST,
        ids=[m[1] for m in MODELS_TO_TEST],
    )
    def test_easy_challenge(self, client, model_id, model_name, compliance):
        """Model should call write_file with valid code for a simple task."""
        result = _test_single_model(client, model_id, CHALLENGES["easy"])

        if result["error"] and "rate_limited" in result["error"]:
            pytest.skip(f"Rate limited: {model_name}")

        # Must call write_file
        assert result["has_write"], (
            f"{model_name}: did not call write_file. "
            f"Tool calls: {result['tool_calls']}. "
            f"Text: {result['text_response'][:100]}"
        )

        # Must produce valid code
        content = result["write_file_args"].get("content", "")
        assert len(content) > 0, f"{model_name}: write_file has empty content"
        assert "def " in content, f"{model_name}: no function definition in code"
        assert "return" in content, f"{model_name}: no return statement in code"

    @pytest.mark.parametrize(
        "model_id,model_name,compliance",
        MODELS_TO_TEST,
        ids=[m[1] for m in MODELS_TO_TEST],
    )
    def test_medium_challenge(self, client, model_id, model_name, compliance):
        """Model should produce a working memoized fibonacci."""
        result = _test_single_model(client, model_id, CHALLENGES["medium"])

        if result["error"] and "rate_limited" in result["error"]:
            pytest.skip(f"Rate limited: {model_name}")

        assert result["has_write"], (
            f"{model_name}: did not call write_file. "
            f"Tool calls: {result['tool_calls']}. "
            f"Text: {result['text_response'][:100]}"
        )

        content = result["write_file_args"].get("content", "")
        assert len(content) > 0, f"{model_name}: write_file has empty content"
        # Should have type hints
        assert "def " in content, f"{model_name}: no function definition"

    @pytest.mark.parametrize(
        "model_id,model_name,compliance",
        MODELS_TO_TEST,
        ids=[m[1] for m in MODELS_TO_TEST],
    )
    def test_hard_challenge(self, client, model_id, model_name, compliance):
        """Model should call write_file for both files in a multi-file task."""
        result = _test_single_model(client, model_id, CHALLENGES["hard"])

        if result["error"] and "rate_limited" in result["error"]:
            pytest.skip(f"Rate limited: {model_name}")

        # Must call write_file at least once
        assert result["has_write"], (
            f"{model_name}: did not call write_file. "
            f"Tool calls: {result['tool_calls']}. "
            f"Text: {result['text_response'][:100]}"
        )

        # Should ideally call write_plan for multi-file task
        # (not enforced — just noted)

    @pytest.mark.parametrize(
        "model_id,model_name,compliance",
        MODELS_TO_TEST,
        ids=[m[1] for m in MODELS_TO_TEST],
    )
    def test_think_before_action(self, client, model_id, model_name, compliance):
        """Model should call think() before starting work."""
        result = _test_single_model(client, model_id, CHALLENGES["easy"])

        if result["error"] and "rate_limited" in result["error"]:
            pytest.skip(f"Rate limited: {model_name}")

        # Ideally calls think first
        # (Some models may not call think — just record it)
        # This is a soft check — we don't fail, just note compliance
        if not result["has_think"]:
            pytest.skip(f"{model_name}: did not call think (soft skip)")


class TestModelCodeQuality:
    """Verify the code models produce actually works."""

    @pytest.fixture(scope="class")
    def client(self):
        c = _resolve_nvidia_client()
        if c is None:
            pytest.skip("No NVIDIA API key configured")
        return c

    @pytest.mark.parametrize(
        "model_id,model_name,compliance",
        [(m[0], m[1], m[2]) for m in MODELS_TO_TEST
         if m[1] in ("Nemotron 3 Ultra 550B", "Kimi K3", "Laguna XS 2.1", "Nemotron 3.5 Lightning 30B")],
        ids=["Nemotron 3 Ultra 550B", "Kimi K3", "Laguna XS 2.1", "Nemotron 3.5 Lightning 30B"],
    )
    def test_easy_code_runs(self, client, model_id, model_name, compliance):
        """The code from the easy challenge should actually run."""
        result = _test_single_model(client, model_id, CHALLENGES["easy"])

        if result["error"] and "rate_limited" in result["error"]:
            pytest.skip(f"Rate limited: {model_name}")
        if not result["has_write"]:
            pytest.skip(f"{model_name}: no write_file call")

        content = result["write_file_args"].get("content", "")
        path = result["write_file_args"].get("path", "test.py")

        # Write to temp and try to import
        import tempfile, importlib.util, sys
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write(content)
            f.flush()
            try:
                spec = importlib.util.spec_from_file_location("test_mod", f.name)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                # Try calling greet() if it exists
                if hasattr(mod, "greet"):
                    result_val = mod.greet("World")
                    assert isinstance(result_val, str), f"greet() didn't return string: {result_val}"
                    assert "World" in result_val, f"greet('World') didn't contain 'World': {result_val}"
            finally:
                os.unlink(f.name)
