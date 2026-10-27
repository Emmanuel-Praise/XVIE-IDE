/** Local file verification for the Browser Agent workflow.
 *
 * Mirrors the spirit of Backend/xvie-agent `execution.py` validators
 * (validate_changed_file, check_contrast, cross-file consistency) for the
 * renderer-side isolated loop, which cannot import Python. Structural
 * problems are ERRORS (the model must fix and re-verify); design smells
 * are WARNINGS (advisory, never block).
 */

export interface VerifyOutcome {
  errors: string[];
  warnings: string[];
}

function balancedPairs(content: string, pairs: Record<string, string>): { balanced: boolean; leftover: string } {
  const closers = new Set(Object.values(pairs));
  const stack: string[] = [];
  let inString: string | null = null;
  let escaped = false;
  for (const char of content) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }
    if (char in pairs) stack.push(char);
    else if (closers.has(char)) {
      const last = stack.pop();
      if (!last || pairs[last] !== char) return { balanced: false, leftover: char };
    }
  }
  return { balanced: stack.length === 0, leftover: stack.join("") };
}

const VOID_HTML = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

/** Structural HTML checks: doctype, required skeleton, unclosed structural tags. */
export function verifyHtmlContent(content: string): string[] {
  const errors: string[] = [];
  if (!/<!doctype\s+html>/i.test(content)) errors.push("Missing <!DOCTYPE html>.");
  for (const tag of ["<html", "<head", "<body"]) {
    if (!content.toLowerCase().includes(tag)) errors.push(`Missing required ${tag}> element.`);
  }
  if (!/<\/html\s*>/i.test(content)) errors.push("Missing closing </html>.");
  // Stack-check structural tags (ignores void elements, comments, scripts content is fine to skip roughly).
  const stripped = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[\s>][\s\S]*?<\/\1\s*>/gi, "");
  const stack: string[] = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^<>]*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(stripped)) !== null) {
    const full = match[0];
    const name = match[1].toLowerCase();
    if (VOID_HTML.has(name) || full.endsWith("/>")) continue;
    if (full.startsWith("</")) {
      const open = stack.pop();
      if (open === undefined) {
        errors.push(`Stray closing </${name}> with no matching opener (truncated chunk?).`);
        break;
      }
      if (open !== name) {
        errors.push(`Mismatched tags: <${open}> closed by </${name}> (truncated or mis-nested chunk?).`);
        break;
      }
    } else {
      stack.push(name);
    }
  }
  if (stack.length > 6) {
    errors.push(`Many unclosed tags (${stack.slice(-4).map((t) => `<${t}>`).join(", ")}, …) — the file looks truncated; finish it with append_file.`);
  } else if (stack.length > 0 && /section|main|div|footer|header|article|nav|ul|form|button|a\b/.test(stack[stack.length - 1])) {
    errors.push(`Unclosed <${stack[stack.length - 1]}> at end of file — the file looks truncated; finish it with append_file.`);
  }
  return errors;
}

/** Strip comments and count CSS-looking blocks hidden inside them. */
function stripCssComments(content: string): { content: string; unclosed: boolean; hiddenRules: number } {
  const output: string[] = [];
  let hiddenRules = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (quote) {
      output.push(char);
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output.push(char);
      continue;
    }
    if (char === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      if (end < 0) return { content: output.join(""), unclosed: true, hiddenRules };
      const comment = content.slice(i, end + 2);
      const selectors = comment.match(/(?:^|\n)\s*(?:[.#][\w-]+|[a-z][\w-]*(?:[.#][\w-]+)?)(?:[^{};\r\n]*)\s*\{\s*(?=[^}]*\})/gi) ?? [];
      const declarations = comment.match(/(?:--[\w-]+|[\w-]+)\s*:\s*[^;{}\r\n]+;/g) ?? [];
      if (selectors.length >= 2 && declarations.length >= 2) hiddenRules += selectors.length;
      output.push(comment.replace(/[^\r\n]/g, " "));
      i = end + 1;
      continue;
    }
    output.push(char);
  }
  return { content: output.join(""), unclosed: false, hiddenRules };
}

/** CSS checks: comments, balanced braces/parens, non-empty. */
export function verifyCssContent(content: string): string[] {
  const errors: string[] = [];
  if (!content.trim()) {
    errors.push("CSS file is empty.");
    return errors;
  }
  const stripped = stripCssComments(content);
  if (stripped.unclosed) errors.push("Unclosed CSS block comment (missing */); the rest of the stylesheet would be ignored.");
  if (stripped.hiddenRules) errors.push(`${stripped.hiddenRules} CSS rule blocks appear inside a comment; check for a misplaced */ that is hiding stylesheet rules.`);
  const braces = balancedPairs(stripped.content, { "{": "}", "(": ")" });
  if (!braces.balanced) errors.push(`Unbalanced CSS braces/parens (leftover '${braces.leftover}') — the file looks truncated; finish it with append_file.`);
  if (!/[{}]/.test(stripped.content)) errors.push("No CSS rules found (no {...} blocks).");
  return errors;
}

function stripJsComments(content: string): { content: string; unclosedBlockComment: boolean } {
  const output = content.split("");
  let quote: string | null = null;
  let escaped = false;
  let unclosedBlockComment = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "/" && content[i + 1] === "/") {
      for (let end = i; end < content.length && content[end] !== "\n"; end += 1) output[end] = " ";
      while (i + 1 < content.length && content[i + 1] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      const stop = end < 0 ? content.length : end + 2;
      for (let index = i; index < stop; index += 1) {
        if (content[index] !== "\n" && content[index] !== "\r") output[index] = " ";
      }
      if (end < 0) {
        unclosedBlockComment = true;
        break;
      }
      i = end + 1;
    }
  }
  return { content: output.join(""), unclosedBlockComment };
}

/** JS checks: comments, balanced delimiters + syntax parse (imports/exports stripped for plain-script check). */
export function verifyJsContent(content: string): string[] {
  const errors: string[] = [];
  if (!content.trim()) {
    errors.push("JS file is empty.");
    return errors;
  }
  const stripped = stripJsComments(content);
  if (stripped.unclosedBlockComment) errors.push("Unclosed JavaScript block comment (missing */); the rest of the file would be ignored.");
  const delims = balancedPairs(stripped.content, { "{": "}", "(": ")", "[": "]" });
  if (!delims.balanced) errors.push(`Unbalanced JS delimiters (leftover '${delims.leftover}') — the file looks truncated; finish it with append_file.`);
  const scriptBody = stripped.content
    .split("\n")
    .filter((line) => !/^\s*import\b/.test(line))
    .join("\n")
    .replace(/\bexport\s+(default\s+)?/g, "");
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(scriptBody);
  } catch (err) {
    if (err instanceof SyntaxError) errors.push(`JS syntax error: ${err.message}`);
  }
  return errors;
}

/** Dispatch by extension. Unknown types get no structural checks. */
export function verifyFileContent(path: string, content: string): string[] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return verifyHtmlContent(content);
  if (lower.endsWith(".css")) return verifyCssContent(content);
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return verifyJsContent(content);
  return [];
}

/** HTML class names with no matching `.class` rule in the given CSS (advisory). */
export function findMissingCssClasses(htmlContents: string[], cssContents: string[]): string[] {
  const classes = new Set<string>();
  for (const html of htmlContents) {
    const withoutScripts = html.replace(/<(script|style)[\s>][\s\S]*?<\/\1\s*>/gi, "");
    for (const match of withoutScripts.matchAll(/class\s*=\s*["']([^"']+)["']/gi)) {
      for (const token of match[1].split(/\s+/)) {
        if (token && !token.includes("{") && !token.includes("}")) classes.add(token);
      }
    }
  }
  const css = cssContents.join("\n");
  return [...classes].filter((cls) => !css.includes(`.${cls}`)).sort();
}

// ---------------------------------------------------------------------------
// WCAG contrast (mirrors xvie check_contrast)
// ---------------------------------------------------------------------------

function luminance(hexColor: string): number | null {
  const hex = hexColor.trim().replace(/^#/, "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const channel = (i: number): number => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio, or null for invalid hex. */
export function contrastRatio(fgHex: string, bgHex: string): number | null {
  const l1 = luminance(fgHex);
  const l2 = luminance(bgHex);
  if (l1 === null || l2 === null) return null;
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function formatContrastReport(fgHex: string, bgHex: string): string {
  const ratio = contrastRatio(fgHex, bgHex);
  if (ratio === null) return "Invalid hex colors (expected #rrggbb).";
  const line = (label: string, pass: boolean, need: string): string =>
    `WCAG ${label}: ${pass ? "PASS" : "FAIL"} (${need} required)`;
  return [
    `Contrast ratio: ${ratio.toFixed(2)}:1`,
    line("AA normal text", ratio >= 4.5, "4.5:1"),
    line("AA large text", ratio >= 3.0, "3.0:1"),
    line("AAA normal", ratio >= 7.0, "7.0:1"),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Plan step title matching (fuzzy, lists open steps on failure)
// ---------------------------------------------------------------------------

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Match a mark_task_done title against plan steps.
 * Order: exact (case-insensitive) → normalized → unique substring.
 * Returns the matched index, or an error message that lists the open steps.
 */
export function matchPlanStepTitle(steps: Array<{ title: string }>, input: string): { index: number } | { error: string } {
  const want = input.trim();
  const openList = steps.map((s) => ` - ${s.title}`).join("\n");
  if (!want) return { error: `mark_task_done needs the plan step title. Open steps:\n${openList}` };
  const exact = steps.findIndex((s) => s.title.toLowerCase() === want.toLowerCase());
  if (exact >= 0) return { index: exact };
  const normWant = normalizeTitle(want);
  if (normWant) {
    const normed = steps.findIndex((s) => normalizeTitle(s.title) === normWant);
    if (normed >= 0) return { index: normed };
    const partials = steps.map((s, i) => ({ s, i })).filter(({ s }) => {
      const norm = normalizeTitle(s.title);
      return norm.includes(normWant) || normWant.includes(norm);
    });
    if (partials.length === 1) return { index: partials[0].i };
    if (partials.length > 1) {
      return { error: `Multiple plan steps match '${want}'. Use one exact title:\n${openList}` };
    }
  }
  return { error: `No plan step matches '${want}'. Use one exact title:\n${openList}` };
}
