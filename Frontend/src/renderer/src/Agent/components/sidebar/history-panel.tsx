import { Square } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useAgentStore } from "../../agentStore";
import { formatDuration } from "../../data/stage-utils";
import type { SessionStatus } from "../../types";

const STATUS_MARK: Record<SessionStatus, string> = {
  completed: "bg-secondary/60",
  running: "bg-green-600 animate-pulse",
  waiting: "bg-amber-500 animate-pulse",
  incomplete: "bg-amber-500",
  stopped: "bg-outline-variant",
  failed: "bg-red-500"
};

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function HistoryPanel({ compact = false }: { compact?: boolean }) {
  const history = useAgentStore((s) => s.history);
  const openSession = useAgentStore((s) => s.openSession);

  if (history.length === 0) {
    return <p className="font-label-xs text-label-xs text-secondary">No sessions yet.</p>;
  }

  return (
    <div className="flex flex-col">
      {history.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => void openSession(entry.id)}
          className="group flex w-full cursor-pointer items-center gap-2 border-b border-outline-variant/60 py-1.5 text-left last:border-b-0 hover:bg-surface-container-low"
        >
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_MARK[entry.status])} />
          <span className="min-w-0 flex-1 truncate font-body-sm text-body-sm text-on-surface">
            {entry.title}
          </span>
          {!compact && <Square size={10} className="shrink-0 text-secondary opacity-0 group-hover:opacity-100" />}
          <span className="flex-none font-label-xs text-label-xs text-secondary">
            {formatDuration(entry.durationMs)}
          </span>
          <span className="flex-none font-label-xs text-label-xs text-secondary">
            {formatDate(entry.date)}
          </span>
        </button>
      ))}
    </div>
  );
}
