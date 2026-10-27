import { ArrowUpRight, FileSearch, MessagesSquare, PenLine, ShieldCheck } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import Logo from "@/Workspace/components/logo";
import { AGENT_MODES } from "../../data/modes";
import { EXAMPLE_PROMPTS } from "../../data/suggestions";
import { useAgentStore } from "../../agentStore";
import { formatDuration } from "../../data/stage-utils";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import type { SessionStatus } from "../../types";

const CAPABILITIES = [
  { icon: FileSearch, text: "Reads your workspace for context" },
  { icon: PenLine, text: "Edits files and creates new ones" },
  { icon: ShieldCheck, text: "Runs checks and verifies its work" },
  { icon: MessagesSquare, text: "Reports progress as it goes" }
];

const STATUS_DOT: Record<SessionStatus, string> = {
  completed: "bg-secondary/60",
  running: "bg-green-600 animate-pulse",
  waiting: "bg-amber-500 animate-pulse",
  incomplete: "bg-amber-500",
  stopped: "bg-outline-variant",
  failed: "bg-red-500"
};

function formatDate(ts: number): string {
  const d = new Date(ts);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Welcome shown in the Xvie Agent dock before a task is started. Mirrors the
 * consolidated design language used across the other assistant surfaces.
 */
export default function AgentDockWelcome(): React.JSX.Element {
  const workspacePath = useFileSystemStore((s) => s.workspace?.path);
  const workspaceName = workspacePath?.split(/[\\/]/).pop() || workspacePath || "Workspace";
  const setDraft = useAgentStore((s) => s.setDraft);
  const setMode = useAgentStore((s) => s.setMode);
  const mode = useAgentStore((s) => s.mode);
  const history = useAgentStore((s) => s.history);
  const openSession = useAgentStore((s) => s.openSession);

  return (
    <div className="agent-code-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4">
      <div className="mx-auto flex w-full max-w-[640px] flex-1 flex-col gap-3">
        {/* Hero */}
        <div className="relative overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-low p-5">
          <div className="pointer-events-none absolute inset-0 opacity-70" style={{ background: "radial-gradient(120% 120% at 100% 0%, color-mix(in srgb, var(--primary) 22%, transparent) 0%, transparent 58%)" }} />
          <div className="relative flex items-start gap-3.5">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-outline-variant bg-surface-container-lowest">
              <Logo className="h-8 w-8" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-headline-sm text-headline-sm font-semibold text-on-surface">Xvie Agent</h2>
              <p className="mt-0.5 font-body-sm text-body-sm text-secondary">
                Edits your project directly. Pick a mode or just ask.
              </p>
              <p className="mt-2 font-label-xs text-label-xs text-editor-text-dim">
                Working in <span className="text-on-surface">{workspaceName}</span>
              </p>
            </div>
          </div>

          <div className="relative mt-4 grid grid-cols-2 gap-2">
            {CAPABILITIES.map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-container-high text-secondary">
                  <Icon size={12} />
                </span>
                <span className="font-label-xs text-label-xs text-on-surface">{text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Modes */}
        <div>
          <p className="mb-1.5 px-1 font-label-xs text-label-xs font-semibold uppercase tracking-wider text-editor-text-dim">
            Modes
          </p>
          <div className="flex flex-wrap gap-1.5">
            {AGENT_MODES.map((item) => {
              const active = mode === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={active}
                  title={item.description}
                  onClick={() => setMode(item.id)}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 font-label-xs text-label-xs font-medium transition-colors",
                    active
                      ? "border-primary/60 bg-primary/15 text-primary"
                      : "border-outline-variant/70 bg-surface-container-low text-secondary hover:border-editor-text-dim/30 hover:text-on-surface"
                  )}
                >
                  <item.icon size={12} />
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Examples */}
        <div>
          <p className="mb-1.5 px-1 font-label-xs text-label-xs font-semibold uppercase tracking-wider text-editor-text-dim">
            Start with an example
          </p>
          <div className="flex flex-col gap-1.5">
            {EXAMPLE_PROMPTS.map((example) => (
              <button
                key={example.label}
                type="button"
                onClick={() => setDraft(example.label)}
                className="group flex items-center gap-2.5 rounded-xl border border-outline-variant/70 bg-surface-container-lowest px-3 py-2.5 text-left transition-colors hover:border-outline hover:bg-surface-container"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-container-high text-secondary transition-colors group-hover:text-primary">
                  <ArrowUpRight size={13} />
                </span>
                <span className="min-w-0 flex-1 truncate font-body-sm text-body-sm text-on-surface">{example.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Recent tasks */}
        <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-3.5">
          <p className="mb-2 font-label-xs text-label-xs font-semibold uppercase tracking-wider text-secondary">Recent tasks</p>
          {history.length === 0 ? (
            <p className="font-label-xs text-label-xs text-secondary">Nothing yet — your sessions will appear here.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {history.slice(0, 4).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => void openSession(entry.id)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-surface-container"
                >
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[entry.status])} />
                  <span className="min-w-0 flex-1 truncate font-label-xs text-label-xs text-on-surface">{entry.title}</span>
                  <span className="flex-none font-label-xs text-label-xs text-secondary">
                    {formatDate(entry.date)} · {formatDuration(entry.durationMs)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
