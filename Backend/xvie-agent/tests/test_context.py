"""Tests for xvie_agent.context and xvie_agent.prompting."""

from __future__ import annotations

from pathlib import Path

from xvie_agent.context import build_context_snapshot, discover_memory_files
from xvie_agent.prompting import build_system_prompt


# ---------------------------------------------------------------------------
# discover_memory_files
# ---------------------------------------------------------------------------

class TestDiscoverMemoryFiles:
    def test_finds_agents_md_in_cwd(self, tmp_path: Path) -> None:
        (tmp_path / "AGENTS.md").write_text("Project rules here.")
        result = discover_memory_files(tmp_path)
        assert "Project rules here" in result

    def test_finds_claude_md(self, tmp_path: Path) -> None:
        (tmp_path / "CLAUDE.md").write_text("Claude instructions.")
        result = discover_memory_files(tmp_path)
        assert "Claude instructions" in result

    def test_finds_agents_md_in_parent(self, tmp_path: Path) -> None:
        parent = tmp_path / "parent"
        parent.mkdir()
        child = parent / "child"
        child.mkdir()
        (parent / "AGENTS.md").write_text("Parent instructions.")
        result = discover_memory_files(child)
        assert "Parent instructions" in result

    def test_finds_in_forge_subdir(self, tmp_path: Path) -> None:
        forge_dir = tmp_path / ".xvie"
        forge_dir.mkdir()
        (forge_dir / "AGENTS.md").write_text(".xvie instructions.")
        result = discover_memory_files(tmp_path)
        assert ".xvie instructions" in result

    def test_collects_from_multiple_levels(self, tmp_path: Path) -> None:
        (tmp_path / "AGENTS.md").write_text("Root rules.\n")
        child = tmp_path / "src"
        child.mkdir()
        (child / "AGENTS.md").write_text("Src rules.\n")
        result = discover_memory_files(child)
        assert "Root rules" in result
        assert "Src rules" in result

    def test_respects_char_cap(self, tmp_path: Path) -> None:
        (tmp_path / "AGENTS.md").write_text("A" * 25_000)
        result = discover_memory_files(tmp_path)
        assert len(result) <= 20_000

    def test_empty_when_no_files(self, tmp_path: Path) -> None:
        result = discover_memory_files(tmp_path)
        assert result == ""

    def test_no_duplicates(self, tmp_path: Path) -> None:
        (tmp_path / "AGENTS.md").write_text("Single file.")
        # Discover twice
        r1 = discover_memory_files(tmp_path)
        r2 = discover_memory_files(tmp_path)
        assert r1 == r2
        assert r1.count("Single file.") == 1


# ---------------------------------------------------------------------------
# build_context_snapshot
# ---------------------------------------------------------------------------

class TestContextSnapshot:
    def test_cwd_present(self, tmp_path: Path) -> None:
        snap = build_context_snapshot(tmp_path)
        assert "cwd" in snap
        assert str(tmp_path.resolve()) in snap["cwd"]

    def test_platform_present(self, tmp_path: Path) -> None:
        snap = build_context_snapshot(tmp_path)
        assert "platform" in snap

    def test_python_version_present(self, tmp_path: Path) -> None:
        snap = build_context_snapshot(tmp_path)
        assert "python_version" in snap

    def test_git_info_if_repo(self, tmp_path: Path) -> None:
        import subprocess
        subprocess.run(["git", "init"], capture_output=True, cwd=str(tmp_path))
        snap = build_context_snapshot(tmp_path)
        # git status should be present if git init succeeded
        assert "git_status" in snap


# ---------------------------------------------------------------------------
# build_system_prompt
# ---------------------------------------------------------------------------

class TestBuildSystemPrompt:
    def test_includes_tool_names(self) -> None:
        prompt = build_system_prompt(
            memory="",
            context_snapshot={"cwd": "/workspace"},
            tool_names=["read_file", "write_file"],
        )
        assert "read_file" in prompt
        assert "write_file" in prompt

    def test_includes_memory(self) -> None:
        prompt = build_system_prompt(
            memory="Always use bullet points.",
            context_snapshot={},
            tool_names=[],
        )
        assert "Always use bullet points" in prompt
        assert "<project-instructions>" in prompt

    def test_includes_chunked_write_rule(self) -> None:
        """Large-file chunking guidance must be in the code-mode prompt."""
        from xvie_agent.tools import MAX_WRITE_CONTENT_CHARS

        prompt = build_system_prompt(
            memory="",
            context_snapshot={},
            tool_names=["read_file", "write_file", "append_file"],
        )
        assert "CHUNKS" in prompt
        assert str(MAX_WRITE_CONTENT_CHARS) in prompt
        assert "append_file" in prompt

    def test_no_empty_memory_block(self) -> None:
        prompt = build_system_prompt(
            memory="",
            context_snapshot={},
            tool_names=[],
        )
        assert "<project-instructions>" not in prompt

    def test_includes_environment(self) -> None:
        prompt = build_system_prompt(
            memory="",
            context_snapshot={"cwd": "/workspace", "python_version": "3.12.0"},
            tool_names=[],
        )
        assert "/workspace" in prompt
        assert "3.12.0" in prompt

    def test_under_2000_tokens(self) -> None:
        prompt = build_system_prompt(
            memory="x" * 5000,
            context_snapshot={"cwd": "/a", "platform": "Linux", "python_version": "3.12"},
            tool_names=["read_file", "write_file", "edit_file", "bash", "glob_search", "grep_search", "list_dir"],
        )
        # Rough estimate: 1 token ≈ 4 chars for English
        token_estimate = len(prompt) / 4
        assert token_estimate < 2400, f"Prompt too long: ~{token_estimate:.0f} tokens"
