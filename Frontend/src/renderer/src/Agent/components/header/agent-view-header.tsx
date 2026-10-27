import { Square, Plus, PanelRightOpen, PanelRightClose, Settings2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useAgentStore } from "../../agentStore";
import { formatDuration } from "../../data/stage-utils";

export default function AgentViewHeader({ onOpenSettings }: { onOpenSettings: () => void }) {
  const session = useAgentStore((s) => s.activeSession());
  const sidebarOpen = useAgentStore((s) => s.sidebarOpen);
  const setSidebarOpen = useAgentStore((s) => s.setSidebarOpen);
  const newTask = useAgentStore((s) => s.newTask);
  const stopTask = useAgentStore((s) => s.stopTask);

  const isRunning = session?.status === "running" || session?.status === "waiting";

  return (
    <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-outline-variant bg-background px-3">
      {/* Left: status mark + title */}
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            isRunning ? "bg-green-600 animate-pulse" : session ? "bg-secondary/60" : "bg-outline-variant"
          )}
        />
        <span className="truncate font-label-sm text-label-sm font-medium text-on-surface">
          {session ? session.title : "New Task"}
        </span>
        {isRunning && session && (
          <span className="shrink-0 font-label-xs text-label-xs text-secondary">
            {formatDuration(session.durationMs)}
          </span>
        )}
      </div>

      {/* Right: actions only — modes live in the composer */}
      <div className="flex shrink-0 items-center gap-0.5">
        {isRunning && (
          <button
            type="button"
            onClick={stopTask}
            className="flex cursor-pointer items-center rounded-md p-1.5 text-red-600 transition-colors hover:bg-surface-container-low"
            title="Stop"
          >
            <Square size={12} fill="currentColor" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="cursor-pointer rounded-md p-1.5 text-secondary transition-colors hover:bg-surface-container-low hover:text-on-surface"
          title={sidebarOpen ? "Hide Agent sidebar" : "Open Agent sidebar"}
          aria-label={sidebarOpen ? "Hide Agent sidebar" : "Open Agent sidebar"}
        >
          {sidebarOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="cursor-pointer rounded-md p-1.5 text-secondary transition-colors hover:bg-surface-container-low hover:text-on-surface"
          title="Provider settings"
          aria-label="Provider settings"
        >
          <Settings2 size={14} />
        </button>
        <button
          type="button"
          onClick={newTask}
          className="flex cursor-pointer items-center rounded-md p-1.5 text-secondary transition-colors hover:bg-surface-container-low hover:text-on-surface"
          title="New task"
        >
          <Plus size={14} />
        </button>
      </div>
    </header>
  );
}
