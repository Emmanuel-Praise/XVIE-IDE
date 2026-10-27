import asyncio

import pytest

import engine


def test_restart_managed_chrome_leaves_external_browser_untouched(monkeypatch):
    stopped = False

    def stop():
        nonlocal stopped
        stopped = True

    monkeypatch.setattr(engine, "_managed_pid", lambda: None)
    monkeypatch.setattr(engine, "stop_chrome", stop)

    with pytest.raises(RuntimeError, match="not managed by Xvie"):
        engine.restart_managed_chrome()

    assert not stopped


def test_restart_managed_chrome_relaunches_the_saved_profile(monkeypatch):
    launched = []
    monkeypatch.setattr(engine, "_managed_pid", lambda: 1234)
    monkeypatch.setattr(engine, "stop_chrome", lambda: None)
    monkeypatch.setattr(engine, "launch_chrome_with_cdp", lambda urls, visible: launched.append((urls, visible)))
    monkeypatch.setattr(engine, "cdp_reachable_quick", lambda timeout=2.0: True)

    result = engine.restart_managed_chrome(visible=True)

    assert result["managed"] is True
    assert result["cdp_reachable"] is True
    assert launched == [(["about:blank"], True)]


def test_send_acceptance_uses_generation_signal_when_composer_stays_filled(monkeypatch):
    async def not_clear(_locator):
        return False

    async def generating(_page, _site):
        return True

    async def unchanged_bubbles(_page, _site):
        return ["old answer"]

    monkeypatch.setattr(engine, "_input_is_clear", not_clear)
    monkeypatch.setattr(engine, "_is_generating", generating)
    monkeypatch.setattr(engine, "read_bubbles", unchanged_bubbles)

    accepted = asyncio.run(engine._send_was_accepted(
        object(), engine.get_site("deepseek"), object(), previous_bubble_count=1
    ))

    assert accepted is True


def test_send_acceptance_uses_new_answer_bubble(monkeypatch):
    async def not_clear(_locator):
        return False

    async def not_generating(_page, _site):
        return False

    async def new_bubble(_page, _site):
        return ["old answer", "new user accepted"]

    monkeypatch.setattr(engine, "_input_is_clear", not_clear)
    monkeypatch.setattr(engine, "_is_generating", not_generating)
    monkeypatch.setattr(engine, "read_bubbles", new_bubble)

    accepted = asyncio.run(engine._send_was_accepted(
        object(), engine.get_site("deepseek"), object(), previous_bubble_count=1
    ))

    assert accepted is True


def test_send_acceptance_rejects_when_no_ui_signal_appears(monkeypatch):
    async def not_clear(_locator):
        return False

    async def not_generating(_page, _site):
        return False

    async def unchanged_bubbles(_page, _site):
        return ["old answer"]

    monkeypatch.setattr(engine, "_input_is_clear", not_clear)
    monkeypatch.setattr(engine, "_is_generating", not_generating)
    monkeypatch.setattr(engine, "read_bubbles", unchanged_bubbles)

    accepted = asyncio.run(engine._send_was_accepted(
        object(), engine.get_site("deepseek"), object(), previous_bubble_count=1
    ))

    assert accepted is False


def test_deepseek_send_candidates_exclude_unrelated_generic_icon_buttons():
    site = engine.get_site("deepseek")

    assert "div[role='button']:has(svg)" not in site.send_candidates
    assert "button:has(svg)" not in site.send_candidates
    assert "div.ds-button--iconLabelPrimary" not in site.send_candidates
    assert any("ds-button--primary.ds-button--filled.ds-button--circle" in selector for selector in site.send_candidates)


def test_qwen_send_candidates_do_not_guess_from_generic_icons():
    site = engine.get_site("qwen")

    assert all(":has(svg)" not in selector for selector in site.send_candidates)
    assert "button:not([disabled]):has(svg)" not in site.send_candidates


def test_send_button_search_stays_near_the_composer():
    site = engine.get_site("deepseek")

    class Button:
        async def evaluate(self, _script):
            return True

        async def is_visible(self):
            return True

        async def is_enabled(self):
            return True

    class Matches:
        def __init__(self, items):
            self.items = items

        async def count(self):
            return len(self.items)

        def nth(self, index):
            return self.items[index]

    class Region:
        def __init__(self, depth=0):
            self.depth = depth

        def locator(self, selector):
            if selector == "xpath=..":
                return Region(self.depth + 1)
            if self.depth == 2 and "ds-button--primary.ds-button--filled.ds-button--circle" in selector:
                return Matches([Button()])
            return Matches([])

    selected = asyncio.run(engine._find_send_button(Region(), site))

    assert isinstance(selected, Button)


def test_wait_for_answer_skips_the_submitted_prompt(monkeypatch):
    prompt = "You are in PLAN mode. USER REQUEST: Build a page. PROJECT FILES: ..."
    reads = 0

    async def read_bubbles(_page, _site):
        nonlocal reads
        reads += 1
        if reads == 1:
            return [prompt]
        return [prompt, "Here is a concise implementation plan."]

    async def no_images(_page, _site):
        return 0

    async def not_generating(_page, _site):
        return False

    async def no_continue(_page):
        return False

    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(engine, "read_bubbles", read_bubbles)
    monkeypatch.setattr(engine, "_count_answer_images", no_images)
    monkeypatch.setattr(engine, "_is_generating", not_generating)
    monkeypatch.setattr(engine, "_click_continue", no_continue)
    monkeypatch.setattr(engine.asyncio, "sleep", no_wait)

    answer = asyncio.run(
        engine.wait_for_answer(
            object(), engine.get_site("deepseek"), min_len=0, sent_query=prompt
        )
    )

    assert answer == "Here is a concise implementation plan."


def test_ensure_chrome_without_visibility_request_keeps_visible_window(monkeypatch):
    monkeypatch.setattr(engine, "cdp_reachable_quick", lambda *_args: True)
    monkeypatch.setattr(engine, "_managed_pid", lambda: 42)
    monkeypatch.setattr(engine, "_chrome_visible", True)
    monkeypatch.setattr(
        engine,
        "set_chrome_visibility",
        lambda visible: (_ for _ in ()).throw(AssertionError(f"unexpected toggle to {visible}")),
    )

    result = engine.ensure_chrome()

    assert result["cdp_reachable"] is True
    assert result["visible"] is True
    assert result["toggled"] is False


def test_agent_query_does_not_turn_project_paths_into_uploads(tmp_path):
    project_file = tmp_path / "styles.css"
    project_file.write_text("body { color: teal; }", encoding="utf-8")
    query = f"Inspect this project file: {project_file}\nThen propose a design."

    # A real path in a coding prompt is ordinary text; it is never treated as
    # an implicit upload. Explicit attachments still travel through file_paths.
    cleaned, files = engine.resolve_query_and_files(query)

    assert cleaned == query
    assert files is None

    explicit_query, explicit_files = engine.resolve_query_and_files(
        "Inspect this attached stylesheet.", file_paths=[str(project_file)]
    )
    assert explicit_query == "Inspect this attached stylesheet."
    assert explicit_files == [str(project_file)]


def test_prompt_whitespace_is_preserved_without_path_removal():
    query = "Review this source:\n\n  .hero {\n    color: teal;\n  }"

    cleaned, files = engine.resolve_query_and_files(query)

    assert cleaned == query
    assert files is None
