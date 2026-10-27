/** Browser copy of Backend/xvie-agent/xvie_agent/modes.py prompts.
 *
 * Duplicated (not imported) on purpose: web LLMs ignore function-calling
 * schemas, so the mode contract rides in-band as prompt text. Keep this file
 * in sync with `modes.py` — same five modes, same plan-first rules, same
 * design-system hook. The backend source of truth is exposed via GET /modes.
 */
import type { AgentMode } from "@/Agent/types";

export interface BrowserXvieModeConfig {
  name: AgentMode;
  displayName: string;
  allowWrite: boolean;
  allowShell: boolean;
  allowWebSearch: boolean;
  laneOverride: string | null;
  researchDepth: "none" | "light" | "deep";
  canGenerateCode: boolean;
}

export const BROWSER_XVIE_MODES: Record<AgentMode, BrowserXvieModeConfig> = {
  plan: {
    name: "plan", displayName: "Plan",
    allowWrite: false, allowShell: false, allowWebSearch: false,
    laneOverride: "reasoning", researchDepth: "deep", canGenerateCode: false,
  },
  code: {
    name: "code", displayName: "Code",
    allowWrite: true, allowShell: true, allowWebSearch: false,
    laneOverride: null, researchDepth: "light", canGenerateCode: true,
  },
  debug: {
    name: "debug", displayName: "Debug",
    allowWrite: true, allowShell: true, allowWebSearch: false,
    laneOverride: "debug", researchDepth: "deep", canGenerateCode: true,
  },
  ask: {
    name: "ask", displayName: "Ask",
    allowWrite: false, allowShell: false, allowWebSearch: false,
    laneOverride: "fast", researchDepth: "light", canGenerateCode: false,
  },
  brainstorm: {
    name: "brainstorm", displayName: "Brainstorm",
    allowWrite: false, allowShell: false, allowWebSearch: true,
    laneOverride: "reasoning", researchDepth: "deep", canGenerateCode: false,
  },
};

export function getBrowserXvieMode(mode: AgentMode): BrowserXvieModeConfig {
  return BROWSER_XVIE_MODES[mode] ?? BROWSER_XVIE_MODES.code;
}

/** Exact ports of modes.py _PLAN_PROMPT/_CODE_PROMPT/_DEBUG_PROMPT/_ASK_PROMPT/_BRAINSTORM_PROMPT. */
export const BROWSER_XVIE_MODE_PROMPTS: Record<AgentMode, string> = {
  plan: `=== PLANNING MODE ===
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
4. RETURN the plan. Call write_plan to SAVE your plan
   (your only write-capable tool in this mode — it does NOT touch user
   code), and ALSO include the full plan as Markdown text in your final
   response so it is visible in the chat.

SIZE LIMIT (hard): keep the ENTIRE write_plan call under ~6000 characters —
large plans get cut off mid-JSON and fail. Short titles, 1-2 sentence
descriptions per step, at most 10 steps. Put detail in the chat-visible
Markdown, not in every step object.

PLAN QUALITY REQUIREMENTS:
- Every step must name the EXACT file(s) to modify
- Include specific function/class names to create or modify
- Reference existing patterns in the codebase to follow
- Identify dependencies between steps
- Note any breaking changes or migration steps
- Be concrete enough that a developer could execute without ambiguity
- When ambiguous, call ask_question (max 4 questions, chips + free text) — the run pauses until the user answers.

DESIGN: for visual work, add design_brief keys tokens, refs, motion_budget,
thesis, stack where relevant. Follow the injected design system.`,

  code: `=== CODE MODE ===
Implement the requested changes and preserve unrelated behavior.
1. Follow an existing plan; otherwise create a short structured plan for multi-step work before editing.
2. Read existing files before targeted edits. Create only files required by the task or plan.
3. Verify changed files with verify_file and fix reported structural or syntax errors.
4. Save completed edits as you go and finish with a concise user-facing summary.`,

  debug: `=== DEBUG MODE ===
You are in DEBUG MODE. Your job is to find and fix the ROOT CAUSE of a bug
or error. You have full write access for investigation and fixes.

DEBUGGING METHODOLOGY (follow this strictly):
1. REPRODUCE: Understand the exact error. Read the error message, stack trace,
   and any pasted context carefully. Identify the error type and location.
2. ISOLATE: Determine which files, functions, and lines are involved.
3. HYPOTHESIZE: Form 2-3 possible root causes with supporting/contradicting evidence.
4. INVESTIGATE: Read the relevant code for each hypothesis. Trace variables,
   check edge cases, follow control flow.
5. TRACE: Follow the execution path step by step from the error site back.
6. IDENTIFY: Pinpoint the EXACT root cause. State it clearly before fixing.
7. FIX: Make the MINIMAL change that fixes the issue. Do not refactor unrelated code.
8. VERIFY: Call verify_file and re-check the reported behavior.

CRITICAL RULES:
- Always read the file BEFORE editing it.
- If a plan exists, follow it; otherwise write_plan FIRST for multi-step fixes.
- Never apply a fix you don't understand.`,

  ask: `=== ASK MODE ===
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
- If you don't know the answer, say so honestly.`,

  brainstorm: `=== BRAINSTORM MODE ===
You are in BRAINSTORM MODE. Your job is to generate IDEAS, explore
alternatives, and provide critical analysis.

CAPABILITIES:
- Generate creative ideas and suggestions
- Evaluate trade-offs between different approaches
- Provide multiple perspectives on a problem
- Critically analyze proposals for risks and opportunities

WORKFLOW:
1. UNDERSTAND the problem or topic thoroughly (inspect project context).
2. GENERATE: Produce multiple distinct ideas or approaches.
3. EVALUATE: For each idea, discuss pros, cons, feasibility, and risks.
4. RECOMMEND: Suggest the best approach with clear reasoning.

OUTPUT FORMAT:
- Start with a brief understanding of the problem
- Present 3-5 distinct ideas/approaches
- For each: description, pros, cons, complexity estimate
- End with a recommendation and next steps

Do NOT write files. Do NOT generate code. Focus on ideas and analysis.`,
};

/** Tools per mode — xvie-canonical names only (mirrors loop.py read-only
 * filtering + write modes). Legacy aliases (list_files, search_text) are
 * still accepted on input via canonicalBrowserToolName, but the model is
 * only ever shown the canonical vocabulary. */
export function toolsForBrowserXvieMode(mode: AgentMode): string {
  switch (mode) {
    case "plan":
      return "list_dir, read_file, glob_search, grep_search, think, write_plan, mark_task_done, ask_question, verify_file, check_contrast, read_ui_reference, finish";
    case "ask":
    case "brainstorm":
      return "list_dir, read_file, glob_search, grep_search, think, ask_question, finish";
    default:
      return "list_dir, read_file, glob_search, grep_search, think, write_plan, mark_task_done, ask_question, search_images, write_file, append_file, edit_file, verify_file, finish";
  }
}

/** Normalize common misspellings before intent detection ("impliment the plan"). */
export function normalizeTaskSpelling(task: string): string {
  return task
    .replace(/\bimpliment(s|ed|ing)?\b/gi, "implement$1")
    .replace(/\bimplemnt(s|ed|ing)?\b/gi, "implement$1")
    .replace(/\bbuid\b/gi, "build");
}

/** True when the user asks to build a previously prepared plan rather than describing new work. */
export function isImplementSavedPlanRequest(task: string): boolean {
  const text = normalizeTaskSpelling(task).trim();
  return /\b(implement|proceed|continue|execute|build|go ahead|do it)\b.{0,40}\b(the\s+)?(saved\s+)?plan\b|^(yes[,!]?\s*)?(implement|proceed with|continue with|build from)\s+(the\s+)?(saved\s+)?plan[.!]*$/i.test(text);
}

/** Provider threads are keyed by site+mode: a thread opened under Plan mode
 * carries planning instructions, so Code mode must never reuse it. */
export function conversationKey(site: string, mode: AgentMode): string {
  return `${site}:${mode}`;
}

/** Compact design-system reminder appended for UI tasks (mirrors design_guidance core taste). */
export const BROWSER_DESIGN_REMINDER = `DESIGN GUIDANCE: Follow the project's existing stack and tokens. Use semantic HTML, responsive layouts, visible focus, meaningful content, and a clear visual hierarchy. Do not use emoji as website icons, decoration, or image placeholders unless the user explicitly asks for emoji; use inline SVG/CSS icons or real images. For menus, catalogs, portfolios, and other image-led pages, search for relevant real photos and use returned direct URLs with descriptive alt text and responsive object-fit. Include the returned photographer/license credit and source link. Image search and verification are available tools; visual quality and token use remain advisory.`;
