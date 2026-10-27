import { useState } from "react";
import { Activity, Brain, Check, ChevronDown, FileSearch, GitBranch, ListTree, Pencil, Search, ShieldCheck, Terminal, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ActivityItem, ActivityKind } from "../../types";

interface ToolRowProps { item: ActivityItem; repeatCount?: number; }

const ICONS: Record<ActivityKind, typeof Activity> = {
  think: Brain, read: FileSearch, write: Pencil, update: Pencil, run: Terminal,
  search: Search, index: ListTree, verify: ShieldCheck, git: GitBranch
};
const TONES: Record<ActivityKind, string> = {
  think: "text-violet-400", read: "text-sky-400", write: "text-amber-400",
  update: "text-amber-400", run: "text-rose-400", search: "text-cyan-400",
  index: "text-blue-400", verify: "text-emerald-400", git: "text-orange-400"
};
const LABELS: Record<ActivityKind, string> = {
  think: "Thought", read: "Read", write: "Change", update: "Update",
  run: "Run", search: "Search", index: "List", verify: "Verify", git: "Git"
};

export default function ToolRow({ item, repeatCount = 1 }: ToolRowProps) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const Icon = ICONS[item.kind] ?? Activity;
  const running = item.status === "running";
  const failed = item.status === "failed";
  const isSummary = item.kind === "think";
  // Thoughts render inline: coloured italic text, always visible, no
  // dropdown, no card behind. Colour/italic is the only distinction.
  if (isSummary) {
    return (
      <div className="flex min-w-0 items-start gap-1.5 py-0.5">
        <span className={TONES[item.kind]} aria-hidden>
          {running ? <span className="agent-tool-spin" /> : <Icon size={13} />}
        </span>
        <p className="min-w-0 flex-1 font-body-sm text-body-sm italic text-violet-400/90">
          {item.detail ?? "The agent is reviewing context and choosing its next step."}
          {repeatCount > 1 ? ` · ${repeatCount} calls` : ""}
        </p>
      </div>
    );
  }
  const diffLines = item.diff?.split(/\r?\n/) ?? [];
  const additions = diffLines.filter((line) => line.startsWith("+") && !line.startsWith("+++" )).length;
  const deletions = diffLines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const previewLines = diffLines.filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))).slice(0, 4);
  const expandable = isSummary || diffLines.length > 0;
  const detail = isSummary ? item.target : item.kind === "write" && item.diff || item.kind === "read" && item.status === "completed" ? item.target : `${item.target}${item.detail ? ` · ${item.detail}` : ""}`;
  const thoughtLabel = item.durationMs && item.durationMs > 0 ? `Thought · ${(item.durationMs / 1000).toFixed(1)}s` : "Thought";

  return (
    <motion.div layout initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: "easeOut" }} className="min-w-0">
      <button type="button" onClick={expandable ? () => setOpen((value) => !value) : undefined} aria-expanded={expandable ? open : undefined} className={`agent-tool-row ${expandable ? "cursor-pointer" : "cursor-default"}`} data-status={item.status} data-kind={item.kind}>
        <span className={`agent-tool-status ${TONES[item.kind]}`} aria-hidden>
          {running ? <span className="agent-tool-spin" /> : failed ? <X size={13} strokeWidth={2.5} /> : isSummary ? <Icon size={13} /> : <Check size={12} strokeWidth={2.5} />}
        </span>
        <span className={`agent-tool-name ${TONES[item.kind]}`}>{LABELS[item.kind]}</span>
        <span className="agent-tool-target" title={detail}>{isSummary ? thoughtLabel : detail}{repeatCount > 1 ? ` · ${repeatCount} calls` : ""}</span>
        {additions > 0 && <span className="agent-tool-diff add">+{additions}</span>}
        {deletions > 0 && <span className="agent-tool-diff del">−{deletions}</span>}
        {expandable && <ChevronDown size={13} className={`shrink-0 text-secondary transition-transform ${open ? "rotate-180" : ""}`} />}
      </button>
      {!open && previewLines.length > 0 && (
        <div className="ml-5 mt-1 max-w-full overflow-hidden rounded border border-outline-variant/60 bg-surface-container-low/50 py-0.5 font-mono text-[10px] leading-4">
          {previewLines.map((line, index) => (
            <div key={`${index}-${line}`} className={`truncate px-2 ${line.startsWith("+") ? "agent-diff-added" : "agent-diff-removed"}`} title={line}>
              {line.slice(0, 180)}
            </div>
          ))}
          {(additions > 4 || deletions > 4) && <div className="px-2 text-secondary">…more changes</div>}
        </div>
      )}
      <AnimatePresence initial={false}>
        {expandable && open && <motion.div key={isSummary ? "thought" : "diff"} initial={reduceMotion ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reduceMotion ? undefined : { height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: "easeOut" }} className="overflow-hidden">
          {isSummary ? (
            <div className="agent-thought-summary ml-5 mt-1 pl-3 pr-2 py-1.5 font-body-sm text-body-sm italic text-on-surface/75">
              {item.detail ?? "The agent is reviewing context and choosing its next step."}
            </div>
          ) : (
            <div className="agent-file-diff ml-5 mt-1 max-h-72 overflow-auto rounded-md bg-surface-container-low/70 py-1 font-mono text-[11px]">
              {diffLines.slice(0, 500).map((line, index) => {
                const tone = line.startsWith("+") ? "agent-diff-added" : line.startsWith("-") ? "agent-diff-removed" : line.startsWith("@@") ? "agent-diff-hunk" : "agent-diff-context";
                return <div key={`${index}-${line}`} className={`whitespace-pre px-2.5 leading-5 ${tone}`}>{line || " "}</div>;
              })}
              {diffLines.length > 500 && <div className="px-2.5 py-1 text-secondary">Diff shortened to 500 lines.</div>}
            </div>
          )}
        </motion.div>}
      </AnimatePresence>
    </motion.div>
  );
}
