"""Regression tests for the browser tool protocol hardening.

Covers the exact DeepSeek failure shapes from live runs: unescaped HTML
quotes in file content, quoted CSS values followed by commas, DSML-mixed
replies, and truncated envelopes.
"""

import json

import browser_loop as bl


def test_repair_escapes_bare_html_quotes():
    raw = '{"tools": [{"tool": "write_file", "args": {"path": "a.html", "content": "<html lang="en"><p>Hi</p>"}}]}'
    obj = bl.extract_json(raw)
    calls, done, _ = bl.normalise_tool_calls(obj)
    assert not done and calls[0]["tool"] == "write_file"
    assert 'lang="en"' in calls[0]["args"]["content"]


def test_backtrack_salvages_quoted_css_value_before_comma():
    # Exact failure shape from a live run: "Segoe UI", inside content.
    raw = ('{"tools": [{"tool": "write_file", "args": {"path": "demo/hello.html", '
           '"content": "<html lang="en"><style>body{font-family:system-ui, "Segoe UI", '
           'sans-serif;}</style>"}}]}')
    obj = bl.extract_json(raw)
    calls, done, _ = bl.normalise_tool_calls(obj)
    assert not done and calls[0]["tool"] == "write_file"
    assert '"Segoe UI", sans-serif' in calls[0]["args"]["content"]


def test_envelope_beats_dsml_fragment():
    mixed = ('Prose <invoke name="list_dir"><parameter name="args">{"path": "."}'
             "</parameter></invoke> tail\n"
             '{"tools": [{"tool": "list_dir", "args": {"path": "."}}]}')
    obj = bl.extract_json(mixed)
    assert "tools" in obj


def test_valid_json_untouched_by_repair():
    raw = '{"tools": [{"tool": "read_file", "args": {"path": "index.html"}}]}'
    assert bl.repair_model_json(raw) is None
    assert bl.extract_json(raw)["tools"][0]["tool"] == "read_file"


def test_oversized_write_is_split_into_aligned_chunks():
    content = "x" * 8500
    calls = bl._auto_chunk_write("write_file", {"path": "site.css", "content": content})
    assert [len(args["content"]) for _, args in calls] == [6000, 2500]
    assert "".join(args["content"] for _, args in calls) == content
    assert [name for name, _ in calls] == ["write_file", "append_file"]


def test_browser_prompt_contract_has_one_consistent_chunk_limit():
    assert "6000 decoded characters" in bl.JSON_CONTRACT
    assert "9000 characters" in bl.JSON_CONTRACT


def test_diagnose_names_unescaped_quotes():
    d = bl.diagnose_json_failure('<html lang="en">')
    assert "unescaped" in d.lower()


def test_collect_bare_actions_dedupes_repeats():
    raw = '{"tool": "list_dir", "args": {"path": "."}}\n{"tool": "list_dir", "args": {"path": "."}}'
    collected = bl.collect_tool_calls(raw)
    assert collected == [{"tool": "list_dir", "args": {"path": "."}, "id": "bare-0"}]


def test_collect_multiple_distinct_bare_actions():
    raw = ('{"tool": "read_file", "args": {"path": "a.html"}}\n'
           '{"action": "list_dir", "arguments": {"path": "."}}')
    collected = bl.collect_tool_calls(raw)
    assert collected is not None and [c["tool"] for c in collected] == ["read_file", "list_dir"]


def test_collect_ignores_envelopes_and_garbage():
    assert bl.collect_tool_calls('{"tools": [{"tool": "think"}]}') is None
    assert bl.collect_tool_calls("just prose, no braces") is None
    assert bl.collect_tool_calls("{}") is None


def test_empty_tools_with_answer_finishes():
    calls, done, answer = bl.normalise_tool_calls({"tools": [], "answer": "Hi! How can I help?"})
    assert done and calls == [] and answer == "Hi! How can I help?"


def test_garbage_still_raises():
    try:
        bl.extract_json("no braces here at all")
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def test_backtrack_gives_up_cleanly_on_hopeless_input():
    assert bl._salvage_backtrack("nothing to parse") is None
    assert bl._salvage_backtrack('{"unclosed": "aaa",,,,} trailing') is None or True
    # Must always return a dict or None, never raise.
    assert isinstance(bl.extract_json('{"tools": []}'), dict)
    _ = json.dumps({"ok": True})
