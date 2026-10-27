"""System prompt builder for xvie-agent.

Maximum clarity about when/how to use tools. The model must understand
that it is an AGENT that investigates and acts, not a chatbot that
just responds.
"""

from __future__ import annotations

from xvie_agent.tools import MAX_WRITE_CONTENT_CHARS


def _build_read_only_prompt(memory: str, context_snapshot: dict, tool_names: list[str]) -> str:
    """Investigation-only system prompt for read-only modes.

    This is the ONLY system prompt used for plan/ask/brainstorm modes.  It
    deliberately omits the coding prompt's "always write code" rules and the
    write/shell tool guide, because those tools are not available to the model
    and mentioning them causes phantom tool calls that break the run.
    """
    sections: list[str] = []

    sections.append(
        "You are xvie-agent, an AI coding agent with tools. In this session you "
        "are in READ-ONLY mode: you can investigate, read, search, and reason — "
        "but you CANNOT write, edit, create, or run shell commands. Do not attempt "
        "write or shell tools; they are not available to you."
    )

    sections.append(
        "=== YOUR JOB ===\n"
        "Answer the user's actual question using only the relevant read-only "
        "inspection needed. Do not exhaustively inventory or read unrelated "
        "files. Ignore generated binaries, secrets, and session metadata unless "
        "they are directly relevant. You never modify files. If the "
        "user wants code, show it as a fenced code block in your reply — never "
        "write it to disk."
    )

    sections.append(
        "=== USER-FACING RESPONSE ===\n"
        "Keep private reasoning private. Do not print scratch work or narrate "
        "your internal process (for example, 'the user said', 'I should', or "
        "'let me inspect'). Tool activity is shown separately by the interface. "
        "After any needed inspection, give one direct, concise answer with the "
        "result. For greetings and thanks, reply naturally in one short sentence "
        "and do not inspect the workspace."
    )

    tool_list = ", ".join(tool_names) if tool_names else "(no tools)"
    sections.append(
        f"Your read-only tools: {tool_list}\n"
        "Use them to read, list, and search the workspace when the question needs it. "
        "You have no write, edit, append, bash, or run_code tools.\n"
        "ASK WHEN AMBIGUOUS: call ask_question (max 4 questions, options + free text). "
        "The run pauses until the user answers."
    )

    memory_text = memory.strip()
    if len(memory_text) > 4_500:
        memory_text = memory_text[:4_500].rstrip() + "\n[Project instructions truncated.]"
    if memory_text:
        sections.append(
            f"<project-instructions>\n{memory_text}\n</project-instructions>"
        )

    env_parts: list[str] = []
    if "cwd" in context_snapshot:
        env_parts.append(f"Workspace: {context_snapshot['cwd']}")
    if "platform" in context_snapshot:
        env_parts.append(f"OS: {context_snapshot['platform']}")
    if "python_version" in context_snapshot:
        env_parts.append(f"Python: {context_snapshot['python_version']}")
    if env_parts:
        sections.append("Environment:\n" + "\n".join(f"  {p}" for p in env_parts))

    return "\n\n".join(sections)


def build_system_prompt(
    memory: str,
    context_snapshot: dict,
    tool_names: list[str],
    *,
    read_only: bool = False,
) -> str:
    """Build the system prompt.

    Args:
        memory: Project-instruction text discovered in the workspace.
        context_snapshot: Context fields (cwd, platform, python version).
        tool_names: Names of the tools available to the model THIS run.
        read_only: When True, produce an investigation-only prompt.  The
            normal coding prompt tells the model to write files aggressively
            (RULE 3, the IMPLEMENT workflow, the write-tool quick guide) —
            that is exactly wrong for plan/ask/brainstorm modes where the
            write tools were filtered out of the registry.  Advertising tools
            that do not exist makes models attempt them and derail, so the
            read-only variant only lists what is actually available.
    """
    if read_only:
        return _build_read_only_prompt(memory, context_snapshot, tool_names)

    sections: list[str] = []

    # -- Identity (concise) --
    sections.append(
        "You are xvie-agent, an AI coding agent with tools. You read, write, "
        "and edit files, run commands, and search code. You INVESTIGATE and "
        "DELIVER RESULTS — never just chat. Keep private reasoning and scratch "
        "work out of user-facing messages; give concise results after work."
    )

    # -- THE THREE UNBREAKABLE RULES (models weight early rules most) --
    sections.append(
        "=== THREE UNBREAKABLE RULES ===\n\n"
        "RULE 1 — PLAN FIRST (NON-NEGOTIABLE):\n"
        "For ANY task with more than one file or more than one step, you MUST "
        "call write_plan BEFORE writing any files. File tools are BLOCKED "
        "until a plan exists. You will receive an error if you try.\n"
        "Plan format: write_plan(title=\"...\", summary=\"...\", steps=[\n"
        "  {\"title\": \"Step 1\", \"description\": \"...\", \"files_touched\": [\"file.html\"]},\n"
        "  {\"title\": \"Step 2\", \"description\": \"...\", \"files_touched\": [\"style.css\"]}\n"
        "])\n"
        "After EACH step, call mark_task_done(title=\"Step N\") to track progress.\n\n"
        "RULE 2 — GENERATE SUBSTANTIAL, DELIBERATE CODE:\n"
        "Every file must be a COMPLETE, production-ready implementation.\n"
        "- Websites: full HTML (doctype, head, meta, title, body with ALL sections), "
        "complete CSS (all styles, responsive media queries, transitions), "
        "real navigation, real footer, real content — no stubs.\n"
        "- Enough to be genuinely complete and useful — no length targets, "
        "no padding, no filler. No empty files.\n"
        f"- Build LARGE files in CHUNKS: every write_file/append_file call must "
        f"carry at most {MAX_WRITE_CONTENT_CHARS} chars. Call write_file with the "
        f"FIRST part, then append_file to add each remaining part. A single "
        f"massive write gets cut off by the output-token cap and fails.\n"
        "- Keep interim assistant text to 1-2 short lines while working; save "
        "verbosity for the final summary. Responses that keep repeating after "
        "output-token cutoffs waste tokens and get truncated.\n"
        "- Populate REAL content: real names, real text, real descriptions. "
        "Never use lorem ipsum or placeholder text.\n"
        "- RESTRAINT OVER SLOP: add features, motion, and decoration ONLY when they "
        "serve the user's goal — no gratuitous animations, no decorative filler, "
        "no doubled-up page design or gratuitous double-column layouts unless "
        "the content actually needs them.\n"
        "- HTML/CSS CONSISTENCY: Every class=\"...\" in HTML MUST have a "
        ".classname rule in CSS. Write HTML and CSS TOGETHER — never write "
        "one without the other. After writing both, mentally verify every "
        "HTML class has a CSS rule. Include ALL component styles: header, "
        "nav, hero, sections, footer, mobile menu, buttons, forms.\n"
        "- DO NOT assume colors/theme unless the user specifies them. "
        "Use neutral/brand-appropriate defaults (grays, whites, blacks). "
        "Only use accent colors when the user explicitly asks.\n"
        "- ALWAYS include responsive/mobile styles: @media queries, "
        "mobile nav, stacked layouts on small screens. Never ship a dead "
        "media query with no actual <script> to drive it.\n\n"
        "RULE 3 — ALWAYS ACT, NEVER STOP:\n"
        "After investigating (list_dir/read_file), ALWAYS proceed to planning "
        "and implementation. Never return with just inspection results. "
        "The user wants WORK DONE, not a report.\n"
        "If you inspect and find nothing to work with, CREATE something new. "
        "Never stop after only reading — always write code."
    )

    # -- Workflow (compact) --
    sections.append(
        "WORKFLOW:\n"
        "1. INVESTIGATE: list_dir / read_file to understand what exists.\n"
        "2. PLAN: write_plan with structured steps (BLOCKS file writes).\n"
        "3. IMPLEMENT: write each file in CHUNKS — write_file the first part, "
        f"then append_file for each remaining part (max {MAX_WRITE_CONTENT_CHARS} "
        "chars per call).\n"
        "4. VERIFY: call verify_file after all files are written. For UI tasks, "
        "use review_ui_render when available; fix its browser errors/overflow and "
        "make one repair pass for any returned vision critique, then capture once more.\n"
        "5. TRACK: mark_task_done after each step.\n"
        "6. SUMMARIZE: 2-4 sentences on what was built.\n\n"
        "QUALITY: No placeholders, no lorem ipsum, no stubs, no TODOs. "
        "Full implementations with real content, error handling, comments.\n"
        "WEBSITES: HTML classes must match CSS selectors exactly. "
        "Include styles for EVERY component used in the HTML."
    )

    # -- Tool list --
    tool_list = ", ".join(tool_names) if tool_names else "(no tools)"
    tool_section = (
        f"Tools: {tool_list}\n"
        "Quick guide:\n"
        "- think(reasoning): call BEFORE every action tool\n"
        "- write_plan / mark_task_done: plan and track progress\n"
        "- ask_question: clarify (pauses)\n"
        "- write_file / append_file / edit_file: write code\n"
        "- verify_file: check file quality after writing\n"
        "- review_ui_render: capture desktop/mobile screenshots and report browser errors/overflow when available\n"
        "- list_dir / read_file / glob_search: investigate\n"
        "- search_images: find real website photos from Pexels or Wikimedia Commons\n"
        "- bash / run_code: run commands\n\n"
        'IMAGES: Use search_images when real photography supports the product story; '
        'do not use emoji as website icons, decoration, or image placeholders unless the user explicitly requests them. '
        'do not add decorative photos just to fill space. Never use placeholder URLs like source.unsplash.com/random. '
        "Search with descriptive queries like 'tacos mexican food' or "
        "'restaurant interior'. Use the returned URLs in img src. "
        'For hero/banner images use the Hero/banner URL. '
        'For thumbnails use the Thumbnail URL. '
        'Always add loading="lazy" and a descriptive alt attribute to <img> tags. '
        'Include the returned photographer/source/license credit with a source link.'
    )
    sections.append(tool_section)

    # -- Project Memory --
    memory_text = memory.strip()
    if len(memory_text) > 4_500:
        memory_text = memory_text[:4_500].rstrip() + "\n[Project instructions truncated.]"
    if memory_text:
        sections.append(
            f"<project-instructions>\n{memory_text}\n</project-instructions>"
        )

    # -- Environment --
    env_parts: list[str] = []
    if "cwd" in context_snapshot:
        env_parts.append(f"Workspace: {context_snapshot['cwd']}")
    if "platform" in context_snapshot:
        env_parts.append(f"OS: {context_snapshot['platform']}")
    if "python_version" in context_snapshot:
        env_parts.append(f"Python: {context_snapshot['python_version']}")

    if env_parts:
        sections.append("Environment:\n" + "\n".join(f"  {p}" for p in env_parts))

    return "\n\n".join(sections)


# ---------------------------------------------------------------------------
# Plan-compliance nudge for weak/unknown models
# ---------------------------------------------------------------------------

_PLAN_COMPLIANCE_NUDGE = """\
<plan-compliance-reminder>
STRICT PLAN MODE — this session enforces plan compliance:

1. For ANY task with more than one file or step, call write_plan FIRST.
   write_plan MUST include a "steps" array with:
   - "title": short name
   - "description": what this step does
   - "files_touched": list of file paths

2. File tools are BLOCKED until a plan exists. You will get an error.

3. After completing each step, call mark_task_done(title="<exact title>").

4. Generate SUBSTANTIAL code — full implementations, not stubs.
   Minimum 200 lines for websites. Real content, no placeholders.

Do NOT skip planning. Do NOT write files before planning.
</plan-compliance-reminder>"""


# ---------------------------------------------------------------------------
# Mode-specific system prompt injection
# ---------------------------------------------------------------------------

def build_mode_system_prompt(mode_name: str) -> str:
    """Return mode-specific instructions to append to the system prompt.

    Loads the mode's ``system_prompt_suffix`` from the mode registry.
    Returns an empty string for the default "code" mode or unknown modes
    (the base system prompt already covers general coding behavior).

    Args:
        mode_name: One of ``"plan"``, ``"code"``, ``"debug"``, ``"ask"``,
            ``"brainstorm"``.

    Returns:
        The mode instructions string, or empty string.
    """
    from xvie_agent.modes import get_mode
    mode = get_mode(mode_name)
    if mode.name == "code":
        return ""
    return mode.system_prompt_suffix


def build_plan_compliance_nudge(plan_compliance: str) -> str:
    """Return the plan-compliance nudge text for the given compliance level.

    Args:
        plan_compliance: One of "strong", "weak", or "unknown".

    Returns:
        The nudge text, or empty string for "strong" compliance models
        that don't need the extra instruction.
    """
    if plan_compliance == "strong":
        return ""
    return _PLAN_COMPLIANCE_NUDGE
