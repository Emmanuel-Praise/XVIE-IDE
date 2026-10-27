export type GitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict"
  | "ignored";

export const GIT_STATUS_META: Record<GitStatus, { label: string; letter: string; color: string }> = {
  modified: { label: "Modified", letter: "M", color: "#E3B341" },
  added: { label: "Added", letter: "A", color: "#7EE787" },
  deleted: { label: "Deleted", letter: "D", color: "#FF7B72" },
  renamed: { label: "Renamed", letter: "R", color: "#79C0FF" },
  untracked: { label: "Untracked", letter: "U", color: "#8B949E" },
  conflict: { label: "Conflict", letter: "C", color: "#FF7B72" },
  ignored: { label: "Ignored", letter: "I", color: "#6E7681" }
};

/**
 * Resolves the git status for a path. Currently returns null (no repo
 * integration yet); the real provider plugs in here without touching UI.
 */
export function gitStatusFor(_path: string): GitStatus | null {
  return null;
}
