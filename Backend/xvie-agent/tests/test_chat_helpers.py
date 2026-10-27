"""Tests for chat terminal helpers — attachment collection/formatting,
size formatting, and the per-turn footer summary.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from xvie_agent.chat import (
    AttachedFile,
    _fmt_bytes,
    _looks_binary,
    collect_attachments,
    format_attachment_block,
    summarize_result,
)
from xvie_agent.types import AgentRunResult, UsageStats


# ---------------------------------------------------------------------------
# Binary detection
# ---------------------------------------------------------------------------

class TestLooksBinary:
    def test_empty_is_not_binary(self) -> None:
        assert _looks_binary(b"") is False

    def test_plain_text_is_not_binary(self) -> None:
        assert _looks_binary(b"print('hello') with no NUL bytes\n" * 10) is False

    def test_nul_heavy_is_binary(self) -> None:
        assert _looks_binary(b"\x00\x01\x02\x00example\x00\x00" * 20) is True


# ---------------------------------------------------------------------------
# collect_attachments
# ---------------------------------------------------------------------------

class TestCollectAttachments:
    def _make_workspace(self, tmp_path: Path) -> Path:
        (tmp_path / "readme.md").write_text("Hello — world!", encoding="utf-8")
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "app.py").write_text("def main(): pass\n", encoding="utf-8")
        (tmp_path / "src" / "data.bin").write_bytes(b"\x00\x01\x02\x03" * 100)
        return tmp_path

    def test_single_file(self, tmp_path: Path) -> None:
        ws = self._make_workspace(tmp_path)
        files = collect_attachments(["readme.md"], ws)
        assert len(files) == 1
        assert files[0].rel_path == "readme.md"
        assert "Hello" in files[0].content

    def test_relative_file_resolves_against_workspace(self, tmp_path: Path) -> None:
        ws = self._make_workspace(tmp_path)
        files = collect_attachments(["src/app.py"], ws)
        assert len(files) == 1
        assert files[0].rel_path == Path("src/app.py").as_posix()

    def test_glob(self, tmp_path: Path) -> None:
        ws = self._make_workspace(tmp_path)
        files = collect_attachments(["src/*.py"], ws)
        assert len(files) == 1
        assert files[0].rel_path.endswith("app.py")

    def test_directory_recurses_and_skips_binary(self, tmp_path: Path) -> None:
        ws = self._make_workspace(tmp_path)
        files = collect_attachments(["src"], ws)
        names = [f.rel_path for f in files]
        assert len(files) == 1
        assert "data.bin" not in " ".join(names)

    def test_missing_path_yields_nothing(self, tmp_path: Path) -> None:
        ws = self._make_workspace(tmp_path)
        assert collect_attachments(["nope.txt"], ws) == []

    def test_dedupes_duplicate_specs(self, tmp_path: Path) -> None:
        ws = self._make_workspace(tmp_path)
        files = collect_attachments(["readme.md", "readme.md"], ws)
        assert len(files) == 1

    def test_truncates_large_files(self, tmp_path: Path) -> None:
        ws = self._make_workspace(tmp_path)
        (ws / "big.txt").write_text("a" * 5000, encoding="utf-8")
        files = collect_attachments(["big.txt"], ws, max_bytes=100)
        assert len(files) == 1
        assert "[truncated]" in files[0].content
        assert len(files[0].content) < 150

    def test_respects_max_files(self, tmp_path: Path) -> None:
        ws = tmp_path
        for i in range(5):
            (ws / f"f{i}.txt").write_text("x", encoding="utf-8")
        assert len(collect_attachments(["f*.txt"], ws, max_files=2)) == 2

    def test_unreadable_files_are_skipped(self, tmp_path: Path) -> None:
        ws = tmp_path
        (ws / "locked.txt").write_text("hi", encoding="utf-8")
        # A directory passed as a "file" spec is skipped without error.
        files = collect_attachments(["locked.txt", "does-not-exist"], ws)
        assert len(files) == 1


# ---------------------------------------------------------------------------
# format_attachment_block
# ---------------------------------------------------------------------------

class TestFormatAttachmentBlock:
    def test_block_contains_path_and_fenced_content(self) -> None:
        files = [AttachedFile(rel_path="src/app.py", content="def main(): pass\n", size=16)]
        block = format_attachment_block(files)
        assert "Attached file: src/app.py" in block
        assert "```py" in block
        assert "def main(): pass" in block

    def test_multiple_files(self) -> None:
        files = [
            AttachedFile(rel_path="a.md", content="one", size=3),
            AttachedFile(rel_path="b.py", content="two", size=3),
        ]
        block = format_attachment_block(files)
        assert block.index("Attached file: a.md") < block.index("Attached file: b.py")

    def test_unicode_content_is_preserved(self) -> None:
        files = [AttachedFile(rel_path="note.md", content="Café — déjà vu 🔥", size=20)]
        block = format_attachment_block(files)
        assert "Café — déjà vu 🔥" in block


# ---------------------------------------------------------------------------
# _fmt_bytes
# ---------------------------------------------------------------------------

class TestFmtBytes:
    def test_bytes(self) -> None:
        assert _fmt_bytes(900) == "900 B"

    def test_kilobytes(self) -> None:
        assert _fmt_bytes(2048) == "2.0 KB"

    def test_megabytes(self) -> None:
        assert _fmt_bytes(5 * 1024 * 1024) == "5.0 MB"


# ---------------------------------------------------------------------------
# summarize_result
# ---------------------------------------------------------------------------

def _make_result(**overrides) -> AgentRunResult:
    defaults: dict = {
        "final_output": "",
        "stop_reason": "completed",
        "turns": 2,
        "tool_calls": [],
        "usage": UsageStats(input_tokens=1000, output_tokens=500),
    }
    defaults.update(overrides)
    return AgentRunResult(**defaults)


class TestSummarizeResult:
    def test_includes_stop_reason_mode_and_turns(self) -> None:
        result = _make_result()
        lines = summarize_result(result, "test-model", "Code", [], [])
        assert "stop: completed" in lines[0]
        assert "mode: Code" in lines[0]
        assert "turns: 2" in lines[0]

    def test_includes_tokens_and_cost(self) -> None:
        result = _make_result()
        lines = summarize_result(result, "test-model", "Code", [], [])
        assert "1,000 in / 500 out / 1,500 total" in lines[1]
        assert "est. $" in lines[1]
        assert "test-model" in lines[1]

    def test_lists_tools_and_caps(self) -> None:
        result = _make_result(tool_calls=["read_file", "write_file", "a", "b", "c", "d", "e", "f"])
        lines = summarize_result(result, "m", "Code", [], ["read_file", "write_file", "a", "b", "c", "d", "e", "f"])
        assert "read_file, write_file" in lines[0]
        assert "+2 more" in lines[0]

    def test_no_tools(self) -> None:
        result = _make_result()
        lines = summarize_result(result, "m", "Code", [], [])
        assert "tools: (none)" in lines[0]

    def test_activities_deduped_and_ordered(self) -> None:
        result = _make_result()
        lines = summarize_result(result, "m", "Code", ["inspecting", "thinking", "inspecting"], [])
        assert "activity: inspecting → thinking" in lines[-1]

    def test_no_activity_line_when_empty(self) -> None:
        result = _make_result()
        lines = summarize_result(result, "m", "Code", [], [])
        assert not any(line.startswith("activity:") for line in lines)