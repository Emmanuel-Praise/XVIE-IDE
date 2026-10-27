"""Agent mode definitions — each mode constrains what the agent can do.

Modes control:
  - Which tools are available (read-only, write, shell, web)
  - System prompt instructions specific to the mode
  - Model routing lane override
  - Whether code generation is allowed
"""

from __future__ import annotations

from dataclasses import dataclass, field


# ---------------------------------------------------------------------------
# Mode configuration
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ModeConfig:
    """Configuration for a single agent mode.

    Attributes:
        name: Machine-readable identifier (e.g. ``"plan"``).
        display_name: Human-friendly label shown in the UI.
        allow_write: Whether the agent can write/edit/create files.
        allow_shell: Whether the agent can execute shell commands.
        allow_web_search: Whether the agent can search the web and fetch URLs.
        tools_always_on: Tools that are ALWAYS available regardless of
            allow_write/allow_shell (read-only inspection tools).
        system_prompt_suffix: Extra instructions appended to the system prompt.
        lane_override: Force a specific routing lane (``None`` = auto-classify).
        research_depth: ``"none"``, ``"light"``, or ``"deep"``.
        can_generate_code: Explicit flag — ``False`` means the agent must
            never emit code, only answer questions or produce plans.
        accepts_error_input: Whether the mode is designed to accept pasted
            error messages, stack traces, and debug context.
    """

    name: str
    display_name: str
    allow_write: bool = False
    allow_shell: bool = False
    allow_web_search: bool = False
    tools_always_on: frozenset[str] = field(default_factory=lambda: frozenset({
        "read_file", "list_dir", "glob_search", "grep_search", "think", "ask_question",
    }))
    system_prompt_suffix: str = ""
    lane_override: str | None = None
    research_depth: str = "none"
    can_generate_code: bool = False
    accepts_error_input: bool = False


# ---------------------------------------------------------------------------
# Mode system prompts
# ---------------------------------------------------------------------------

_PLAN_PROMPT = """\
=== PLANNING MODE ===
You are in PLANNING MODE. Your ONLY job is to produce a comprehensive,
detailed implementation plan. You CANNOT write, edit, or create any files.

YOUR WORKFLOW:
1. INVESTIGATE THOROUGHLY: Use read_file, list_dir, glob_search, grep_search
   to deeply understand the codebase. Read EVERY relevant file. Understand the
   architecture, patterns, conventions, and dependencies.
2. RESEARCH: Trace how existing features are implemented. Find similar patterns
   you can follow. Identify all files that will need changes.
3. PLAN: Produce a detailed Markdown implementation plan with:
   - Clear problem statement
   - Architecture decisions and rationale
   - Step-by-step tasks with specific file changes
   - Code patterns to follow (reference existing code)
   - Edge cases and risks
   - Testing strategy
4. RETURN the plan. Call write_plan to SAVE your plan to .xvie/plans/
   (your only write-capable tool in this mode — it does NOT touch user
   code), and ALSO include the full plan as Markdown text in your final
   response so it is visible in the chat.

PLAN QUALITY REQUIREMENTS:
- Every step must name the EXACT file(s) to modify
- Include specific function/class names to create or modify
- Reference existing patterns in the codebase to follow
- Identify dependencies between steps
- Note any breaking changes or migration steps
- Be concrete enough that a developer could execute without ambiguity

You have ONLY these tools: read_file, list_dir, glob_search, grep_search,
think, write_plan, and mark_task_done. You have NO write_file/edit_file/
bash tools. Never call a tool that is not in that list.
"""

_CODE_PROMPT = """\
=== CODE MODE ===
You are in CODE MODE. Your job is to IMPLEMENT — write, edit, and create
files, run commands, and deliver working code.

WORKFLOW:
1. If a plan exists (from a prior /plan invocation), follow it step by step.
   Mark each task done after completing it.
2. If no plan exists, investigate first, then implement directly.
3. Use write_file, edit_file, append_file for code changes.
4. Use bash/run_code to test and verify your work.
5. Call verify_file after writing to catch issues early.

Generate COMPLETE, production-ready code. No stubs, no placeholders, no TODOs.
"""

_DEBUG_PROMPT = """\
=== DEBUG MODE ===
You are in DEBUG MODE. Your job is to find and fix the ROOT CAUSE of a bug
or error. You have full write and shell access for investigation and fixes.

DEBUGGING METHODOLOGY (follow this strictly):
1. REPRODUCE: Understand the exact error. Read the error message, stack trace,
   and any pasted context carefully. Identify the error type and location.
2. ISOLATE: Determine which files, functions, and lines are involved.
   Use grep_search to find related code. Use read_file to examine the
   full context around the error site.
3. HYPOTHESIZE: Form 2-3 possible root causes. For each:
   - What evidence supports this hypothesis?
   - What evidence contradicts it?
   - What code path leads to the error?
4. INVESTIGATE: Read the relevant code for each hypothesis. Trace variables,
   check edge cases, follow control flow. Use bash to run targeted tests
   or reproduce the issue.
5. TRACE: Follow the execution path step by step from the error site
   back to the source of the problem.
6. IDENTIFY: Pinpoint the EXACT root cause. State it clearly before fixing.
7. FIX: Make the MINIMAL change that fixes the issue. Do not refactor
   unrelated code. Do not add features.
8. VERIFY: Run tests, reproduce the original scenario, or write a targeted
   test to confirm the fix works.

CRITICAL RULES:
- Always read the file BEFORE editing it.
- Always understand WHY the error occurs before fixing it.
- Never apply a fix you don't understand.
- If you can't find the root cause after thorough investigation, say so
  clearly rather than guessing.
- If pasted error context is provided, analyze it first before touching code.
"""

_ASK_PROMPT = """\
=== ASK MODE ===
You are in ASK MODE. Your job is to ANSWER QUESTIONS about the codebase,
architecture, or programming concepts. You CANNOT generate, write, edit,
or create any code files.

RULES:
- Use read-only tools (read_file, list_dir, glob_search, grep_search) to
  investigate the codebase and gather information.
- Provide clear, accurate, well-structured answers.
- Reference specific files, functions, and line numbers when explaining code.
- If the question requires code to answer, show it in a fenced code block
  as part of your explanation — but do NOT write it to any file.
- If you don't know the answer, say so honestly.
"""

_BRAINSTORM_PROMPT = """\
=== BRAINSTORM MODE ===
You are in BRAINSTORM MODE. Your job is to generate IDEAS, explore
alternatives, and provide critical analysis. You have web search access
for research.

CAPABILITIES:
- Generate creative ideas and suggestions
- Research best practices, trends, and prior art via web search
- Evaluate trade-offs between different approaches
- Provide multiple perspectives on a problem
- Critically analyze proposals for risks and opportunities

WORKFLOW:
1. UNDERSTAND the problem or topic thoroughly.
2. RESEARCH: Use web_search to find relevant information, prior art,
   best practices, and community opinions.
3. GENERATE: Produce multiple distinct ideas or approaches.
4. EVALUATE: For each idea, discuss pros, cons, feasibility, and risks.
5. RECOMMEND: Suggest the best approach with clear reasoning.

OUTPUT FORMAT:
- Start with a brief understanding of the problem
- Present 3-5 distinct ideas/approaches
- For each: description, pros, cons, complexity estimate
- End with a recommendation and next steps
- Cite sources from web search where relevant

Do NOT write files. Do NOT generate code. Focus on ideas and analysis.
"""


# ---------------------------------------------------------------------------
# Mode registry
# ---------------------------------------------------------------------------

MODES: dict[str, ModeConfig] = {
    "plan": ModeConfig(
        name="plan",
        display_name="Plan",
        allow_write=False,
        allow_shell=False,
        allow_web_search=False,
        system_prompt_suffix=_PLAN_PROMPT,
        lane_override="reasoning",
        research_depth="deep",
        can_generate_code=False,
    ),
    "code": ModeConfig(
        name="code",
        display_name="Code",
        allow_write=True,
        allow_shell=True,
        allow_web_search=False,
        system_prompt_suffix=_CODE_PROMPT,
        lane_override=None,  # auto-classify
        research_depth="light",
        can_generate_code=True,
    ),
    "debug": ModeConfig(
        name="debug",
        display_name="Debug",
        allow_write=True,
        allow_shell=True,
        allow_web_search=False,
        system_prompt_suffix=_DEBUG_PROMPT,
        lane_override="debug",
        research_depth="deep",
        can_generate_code=True,
        accepts_error_input=True,
    ),
    "ask": ModeConfig(
        name="ask",
        display_name="Ask",
        allow_write=False,
        allow_shell=False,
        allow_web_search=False,
        system_prompt_suffix=_ASK_PROMPT,
        lane_override="fast",
        research_depth="light",
        can_generate_code=False,
    ),
    "brainstorm": ModeConfig(
        name="brainstorm",
        display_name="Brainstorm",
        allow_write=False,
        allow_shell=False,
        allow_web_search=True,
        system_prompt_suffix=_BRAINSTORM_PROMPT,
        lane_override="reasoning",
        research_depth="deep",
        can_generate_code=False,
    ),
}

# Default mode when none is specified
DEFAULT_MODE = "code"

# All valid mode names
VALID_MODES = frozenset(MODES.keys())


# ---------------------------------------------------------------------------
# Lookup helpers
# ---------------------------------------------------------------------------

def get_mode(name: str) -> ModeConfig:
    """Look up a mode by name, falling back to DEFAULT_MODE.

    Args:
        name: Mode name (case-insensitive).  Unknown names fall back
            to the default mode.

    Returns:
        The :class:`ModeConfig` for the requested mode.
    """
    key = name.lower().strip()
    if key in MODES:
        return MODES[key]
    return MODES[DEFAULT_MODE]


def is_valid_mode(name: str) -> bool:
    """Return True if *name* is a recognized mode."""
    return name.lower().strip() in MODES
