import { useMemo } from "react";
import { useAgentStore } from "../../agentStore";
import type { ActivityItem } from "../../types";

interface FileChange {
  target: string;
  additions: number;
  deletions: number;
  failed: boolean;
  running: boolean;
  lastTs: number;
}

/** Aggregates write/update activity into per-file change entries. */
export default function ChangesPanel() {
  const session = useAgentStore((s) => s.activeSession());

  const changes = useMemo<FileChange[]>(() => {
    if (!session) return [];
    const byFile = new Map<string, FileChange>();
    for (const item of session.activity) {
      if (item.kind !== "write" && item.kind !== "update") continue;
      const existing = byFile.get(item.target);
      const stats = {
        additions: item.additions ?? 0,
        deletions: item.deletions ?? 0
      };
      if (existing) {
        existing.additions += stats.additions;
        existing.deletions += stats.deletions;
        existing.failed = item.status === "failed";
        existing.running = item.status === "running";
        existing.lastTs = Math.max(existing.lastTs, item.timestamp);
      } else {
        byFile.set(item.target, {
          target: item.target,
          ...stats,
          failed: item.status === "failed",
          running: item.status === "running",
          lastTs: item.timestamp
        });
      }
    }
    return [...byFile.values()].sort((a, b) => b.lastTs - a.lastTs);
  }, [session]);

  if (changes.length === 0) {
    return <p className="font-label-xs text-label-xs text-secondary">No files changed yet.</p>;
  }

  return (
    <div className="flex flex-col">
      {changes.map((c) => (
        <div
          key={c.target}
          className="flex items-center gap-2 border-b border-outline-variant/60 py-1.5 last:border-b-0"
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              c.failed ? "bg-red-500" : c.running ? "bg-green-600 animate-pulse" : "bg-secondary/50"
            }`}
          />
          <span className="min-w-0 flex-1 truncate font-label-xs text-label-xs text-on-surface" title={c.target}>
            {c.target}
          </span>
          <span className="flex-none font-label-xs text-label-xs">
            {c.additions > 0 && <span className="text-green-600 dark:text-green-500">+{c.additions}</span>}
            {c.additions > 0 && c.deletions > 0 && <span className="text-secondary"> </span>}
            {c.deletions > 0 && <span className="text-red-600 dark:text-red-500">−{c.deletions}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
