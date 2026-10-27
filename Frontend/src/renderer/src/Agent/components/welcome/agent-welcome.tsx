import { Hammer, Sparkles, Wrench, FileSearch, TestTube, RotateCcw, PenLine, ShieldCheck, MessagesSquare } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import Logo from "@/Workspace/components/logo";
import { SUGGESTIONS } from "../../data/suggestions";
import { useAgentStore } from "../../agentStore";
import { formatDuration } from "../../data/stage-utils";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import type { SessionStatus } from "../../types";

const STARTER_IDS = ["refactor", "feature", "bug", "explain", "tests", "review"] as const;

const CARD_ICONS: Record<string, typeof Hammer> = {
  refactor: Hammer,
  feature: Sparkles,
  bug: Wrench,
  explain: FileSearch,
  tests: TestTube,
  review: RotateCcw
};

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

export default function AgentWelcome() {
  const workspacePath = useFileSystemStore((s) => s.workspace?.path);
  const workspaceName = workspacePath?.split(/[\\/]/).pop() || workspacePath || "Workspace";
  const setDraft = useAgentStore((s) => s.setDraft);
  const history = useAgentStore((s) => s.history);
  const openSession = useAgentStore((s) => s.openSession);

  const starters = STARTER_IDS.map((id) => SUGGESTIONS.find((s) => s.id === id)).filter(
    (s): s is (typeof SUGGESTIONS)[number] => Boolean(s)
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6 pt-8">
      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col">
        {/* Top: centered logo + headline */}
        <div className="flex flex-col items-center text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full border border-outline-variant bg-surface-container-lowest">
            <Logo className="h-6 w-6" />
          </div>
          <h1 className="mt-4 font-headline-md text-headline-md font-semibold text-on-surface">
            What should we work on?
          </h1>
          <p className="mt-1 font-body-sm text-body-sm text-secondary">
            Working in <span className="font-label-xs text-label-xs text-on-surface">{workspaceName}</span>
          </p>
        </div>

        {/* Bottom: asymmetric split — hero + recent on the left, action cards right */}
        <div className="mt-8 grid flex-1 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          {/* Left column: hero box, then a separate recent card below */}
          <div className="flex flex-col gap-3">
            {/* Hero box */}
            <div className="flex flex-col rounded-2xl border border-outline-variant bg-surface-container-low p-5">
              <h2 className="font-headline-sm text-headline-sm font-semibold text-on-surface">
                Ask, plan, or build — right here.
              </h2>
              <p className="mt-2 font-body-sm text-body-sm text-secondary">
                The agent works directly in your workspace and reports back each step.
              </p>

              <div className="mt-4 flex flex-col gap-2.5 border-t border-outline-variant/70 pt-4">
                {CAPABILITIES.map(({ icon: Icon, text }) => (
                  <div key={text} className="flex items-center gap-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-container-high text-secondary">
                      <Icon size={12} />
                    </span>
                    <span className="font-label-xs text-label-xs text-on-surface">{text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Recent tasks — its own card, visually separate from the hero */}
            <div className="flex flex-col rounded-2xl border border-outline-variant bg-surface-container-lowest p-4">
              <p className="mb-2 font-label-xs text-label-xs font-semibold uppercase tracking-wider text-secondary">
                Recent tasks
              </p>
              {history.length === 0 ? (
                <p className="font-label-xs text-label-xs text-secondary">Nothing yet — your sessions will appear here.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {history.slice(0, 4).map((entry) => (
                    <button key={entry.id} type="button" onClick={() => void openSession(entry.id)} className="flex w-full items-center gap-2 text-left hover:bg-surface-container">
                      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[entry.status])} />
                      <span className="min-w-0 flex-1 truncate font-label-xs text-label-xs text-on-surface">
                        {entry.title}
                      </span>
                      <span className="flex-none font-label-xs text-label-xs text-secondary">
                        {formatDate(entry.date)} · {formatDuration(entry.durationMs)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Action cards — icon, title, description each in its own card */}
          <div className="grid grid-cols-2 gap-3">
            {starters.map((s) => {
              const Icon = CARD_ICONS[s.icon] ?? Sparkles;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setDraft(s.prompt)}
                  className="group flex cursor-pointer flex-col gap-1 rounded-xl border border-outline-variant bg-surface-container-lowest p-3.5 text-left transition-all hover:-translate-y-0.5 hover:border-outline hover:shadow-sm"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-container-high text-on-surface transition-colors group-hover:bg-primary group-hover:text-on-primary">
                    <Icon size={13} />
                  </span>
                  <span className="mt-1 font-label-sm text-label-sm font-semibold text-on-surface">
                    {s.title}
                  </span>
                  <span className="font-body-sm text-body-sm text-secondary">{s.description}</span>
                </button>
              );
            })}
          </div>
        </div>

        <p className="mt-6 text-center font-label-xs text-label-xs text-secondary">
          Enter to send · @ to attach a file
        </p>
      </div>
    </div>
  );
}
