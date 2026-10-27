"""Persistent design-preference memory.

Answers captured by the chat ``/design`` command (or direct callers) are
stored in ``.xvie/design-memory.json`` inside the workspace and injected into
the discovery context on every future build so the agent respects established
preferences instead of re-asking.
"""

from __future__ import annotations

import json
from pathlib import Path

DESIGN_MEMORY_DIR = ".xvie"
DESIGN_MEMORY_FILE = "design-memory.json"

_KEYS = ("style", "accent", "font", "animation", "stack")

# Structured blocks (PRODUCT vs DESIGN split). Values may be dicts
# (rendered one line per sub-key) or plain strings. Unknown keys are
# still dropped silently, exactly like flat keys.
_STRUCTURED_KEYS = ("product", "design")


def _memory_path(workspace_root: Path) -> Path:
    return workspace_root / DESIGN_MEMORY_DIR / DESIGN_MEMORY_FILE


def load_design_memory(workspace_root: Path) -> dict:
    """Return saved design preferences (empty dict when none exist)."""
    path = _memory_path(workspace_root)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_design_memory(workspace_root: Path, prefs: dict) -> dict:
    """Merge ``prefs`` into the persisted memory file and return the result."""
    data = load_design_memory(workspace_root)
    valid = {k: v for k, v in prefs.items() if k in _KEYS and v}
    for key in _STRUCTURED_KEYS:
        value = prefs.get(key)
        if isinstance(value, dict) and value:
            valid[key] = {k: v for k, v in value.items() if v}
        elif isinstance(value, str) and value.strip():
            valid[key] = value.strip()
    data.update(valid)
    data["_saved_at"] = __import__("datetime").datetime.now().isoformat(timespec="seconds")
    path = _memory_path(workspace_root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass
    return data


def format_design_memory(prefs: dict) -> str:
    """Render saved preferences as a prompt block (empty when none)."""
    if not prefs:
        return ""
    lines = [f"- {key}: {prefs[key]}" for key in _KEYS if prefs.get(key)]
    for key in _STRUCTURED_KEYS:
        value = prefs.get(key)
        if isinstance(value, dict):
            lines.extend(
                f"- {key}.{sub}: {value[sub]}" for sub in value if value[sub]
            )
        elif isinstance(value, str) and value.strip():
            lines.append(f"- {key}: {value.strip()}")
    return "\n".join(lines) if lines else ""