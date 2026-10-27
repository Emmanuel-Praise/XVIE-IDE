import type { BrowserSiteId } from "../../../shared/ipc-types";

/**
 * Structured tool-activity model for the Browser Agent, mirroring xvie's
 * `ActivityItem` (Agent/types.ts) field-for-field so xvie's own `ToolRow`
 * renders browser runs identically. Deliberately a separate type: zero
 * coupling to the Agent store — xvie code is never touched.
 */
export type BrowserActivityKind =
  | "think"
  | "read"
  | "write"
  | "update"
  | "run"
  | "search"
  | "index"
  | "verify"
  | "git";

export interface BrowserActivityItem {
  id: string;
  kind: BrowserActivityKind;
  /** Same semantics as xvie's `target`: file path / query / step label. */
  target: string;
  /** Raw browser tool name (list_files, read_file, …) for debugging. */
  tool?: string;
  /** Human detail: char counts, durations, errors, thought text. */
  detail?: string;
  status: "running" | "completed" | "failed";
  timestamp: number;
  /** Unified diff for write/append/edit activity (rendered +N −N). */
  additions?: number;
  deletions?: number;
  diff?: string;
  durationMs?: number;
}

export function browserActivityId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const TOOL_KINDS: Record<string, BrowserActivityKind> = {
  list_files: "index",
  read_file: "read",
  search_text: "search",
  write_file: "write",
  append_file: "update",
  edit_file: "update",
  finish: "verify",
};

export function kindForTool(tool: string): BrowserActivityKind {
  return TOOL_KINDS[tool] ?? "run";
}

/** Start a `running` row at dispatch time; the caller flips it on result. */
export function startActivity(
  tool: string,
  target: string,
  detail?: string
): BrowserActivityItem {
  return {
    id: browserActivityId("bact"),
    kind: kindForTool(tool),
    target,
    tool,
    detail,
    status: "running",
    timestamp: Date.now(),
  };
}

export function completeActivity(
  item: BrowserActivityItem,
  detail?: string,
  startedAt?: number
): BrowserActivityItem {
  return {
    ...item,
    status: "completed",
    detail: detail ?? item.detail,
    timestamp: item.timestamp,
    durationMs: startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : item.durationMs,
  };
}

export function failActivity(
  item: BrowserActivityItem,
  error: string,
  startedAt?: number
): BrowserActivityItem {
  return {
    ...item,
    status: "failed",
    detail: error,
    durationMs: startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : item.durationMs,
  };
}

/** Model `summary` → xvie-style `think` row, shown before the next task. */
export function thinkActivity(
  site: BrowserSiteId,
  summary: string,
  durationMs?: number
): BrowserActivityItem {
  return {
    id: browserActivityId("think"),
    kind: "think",
    target: site,
    detail: summary,
    status: "completed",
    timestamp: Date.now(),
    durationMs,
  };
}

/** Minimal unified diff used for +N −N badges and the diff viewer. */
export function diffForChange(path: string, before: string, after: string): {
  diff: string;
  additions: number;
  deletions: number;
} {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  // Longest-common-prefix/suffix hunk: exact for appends, compact otherwise.
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const head = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
  ];
  const body: string[] = [];
  for (const line of removed) body.push(`-${line}`);
  for (const line of added) body.push(`+${line}`);
  const full = [...head, ...body].join("\n");
  // Cap stored diffs: badges + viewer need hunks, not whole files.
  const capped = full.length > 12_000 ? `${full.slice(0, 12_000)}\n…diff truncated` : full;
  return { diff: capped, additions: added.length, deletions: removed.length };
}

/** Compose the final assistant message: summary + changed-file section. */
export function composeFinalMessage(summary: string, files: Array<{ path: string }>): string {
  const body = (summary || "Done.").trim();
  if (!files.length) return body;
  const list = files.map((file) => `- \`${file.path}\``).join("\n");
  return `${body}\n\n**Changed files**\n${list}`;
}

export interface BrowserTimelineEntry {
  key: string;
  ts: number;
  kind: "activity";
  item: BrowserActivityItem;
}

/** Chronological activity stream (xvie interleaves messages + activity). */
export function activityTimeline(items: BrowserActivityItem[]): BrowserTimelineEntry[] {
  return [...items]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((item) => ({ key: item.id, ts: item.timestamp, kind: "activity" as const, item }));
}
