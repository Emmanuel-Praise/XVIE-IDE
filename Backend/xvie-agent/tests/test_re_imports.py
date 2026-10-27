"""Regression: every module using ``re.`` must import it (plan-mode crash)."""

from __future__ import annotations

import ast
from pathlib import Path


def _modules_using_re():
    root = Path(__file__).resolve().parent.parent / "xvie_agent"
    mods = []
    for p in sorted(root.rglob("*.py")):
        try:
            src = p.read_text(encoding="utf-8")
        except OSError:
            continue
        try:
            tree = ast.parse(src)
        except SyntaxError:
            continue
        uses_re_attr = any(
            isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "re"
            for n in ast.walk(tree)
        )
        uses_re_name = any(
            isinstance(n, ast.Name) and n.id == "re" for n in ast.walk(tree)
        )
        if not (uses_re_attr or uses_re_name):
            continue
        has_import = ("import re" in src)
        mods.append((p, has_import))
    return mods


class TestReImports:
    def test_all_re_users_import_re(self):
        missing = [str(p) for p, ok in _modules_using_re() if not ok]
        assert not missing, f"modules use re. without importing it: {missing}"

    def test_loop_rate_limit_lambda_parses(self):
        """The exact plan-mode lambda in loop.py must not raise NameError."""
        import re

        # Mirror of loop.py on_rate_limit_wait payload parsing.
        def retry_in(msg: str) -> dict:
            return (
                {"retry_in": int(re.search(r"(?:waiting|in) (\d+)s", msg).group(1))}
                if re.search(r"(?:waiting|in) (\d+)s", msg)
                else {}
            )

        assert retry_in("Rate limit hit — waiting 5s before retrying") == {"retry_in": 5}
        assert retry_in("no digits here") == {}

    def test_loop_module_imports_re(self):
        import xvie_agent.loop as loop_mod

        assert hasattr(loop_mod, "re"), "xvie_agent.loop must expose `re` (import re at top)"
