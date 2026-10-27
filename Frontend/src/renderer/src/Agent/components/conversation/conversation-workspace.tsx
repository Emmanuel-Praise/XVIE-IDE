import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Check, Loader2, Play } from "lucide-react";
import { motion } from "framer-motion";
import type { AgentSession } from "../../types";
import { useAgentStore } from "../../agentStore";
import MessageItem from "./message-item";
import QuestionCard from "./question-card";
import ToolRow from "./tool-row";
import { visibleAgentDraft } from "../../agentDraft";
import Logo from "@/Workspace/components/logo";

type Entry =
  | { type: "message"; ts: number; key: string; index: number }
  | { type: "activity"; ts: number; key: string; index: number; repeatCount?: number }
  | { type: "compaction"; ts: number; key: string }
  | { type: "agent"; ts: number; key: string; current: boolean };

function buildTimeline(session: AgentSession): Entry[] {
  const ordered: Entry[] = [
    ...(session.contextSummary ? [{ type: "compaction" as const, ts: session.createdAt - 1, key: `compaction-${session.id}` }] : []),
    ...session.messages.map((message, index) => ({ type: "message" as const, ts: message.timestamp, key: message.id, index })),
    ...session.activity.map((activity, index) => ({ type: "activity" as const, ts: activity.timestamp, key: activity.id, index }))
  ];
  ordered.sort((a, b) => a.ts - b.ts);
  const grouped: Entry[] = [];
  for (const entry of ordered) {
    const previous = grouped[grouped.length - 1];
    if (entry.type === "activity" && previous?.type === "activity") {
      const item = session.activity[entry.index];
      const prior = session.activity[previous.index];
      if (item.kind === "read" && prior.kind === "read" && item.target === prior.target && item.status === "completed" && prior.status === "completed") {
        previous.repeatCount = (previous.repeatCount ?? 1) + 1;
        previous.ts = entry.ts;
        continue;
      }
    }
    grouped.push(entry);
  }
  ordered.splice(0, ordered.length, ...grouped);
  const latestUserIndex = ordered.reduce((latest, entry, index) => entry.type === "message" && session.messages[entry.index].role === "user" ? index : latest, -1);
  const entries: Entry[] = [];
  let markerForTurn = false;
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    if (entry.type === "message" && session.messages[entry.index].role === "user") markerForTurn = false;
    else if (!markerForTurn && (entry.type === "activity" || entry.type === "message" && session.messages[entry.index].role === "assistant")) {
      entries.push({ type: "agent", ts: entry.ts, key: `agent-${entry.key}`, current: session.status === "running" && index > latestUserIndex });
      markerForTurn = true;
    }
    entries.push(entry);
  }
  if (session.status === "running" && latestUserIndex >= 0 && !markerForTurn) {
    const userEntry = ordered[latestUserIndex];
    const userPosition = entries.findIndex((entry) => entry.key === userEntry.key);
    entries.splice(userPosition + 1, 0, { type: "agent", ts: userEntry.ts, key: `agent-pending-${userEntry.key}`, current: true });
  }
  return entries;
}

export default function ConversationWorkspace({ session }: { session: AgentSession }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const entries = buildTimeline(session);
  const answerQuestions = useAgentStore((s) => s.answerQuestions);
  const approvePlan = useAgentStore((s) => s.approvePlan);
  const continuePlan = useAgentStore((s) => s.continuePlan);
  const showQuestions = (session.pendingQuestions?.length ?? 0) > 0;
  const showPlanActions = session.approvalPending && session.approvalType === "plan";

  useEffect(() => {
    if (!session.progressUntil) return;
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [session.progressUntil]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && followLatest.current) {
      element.scrollTop = element.scrollHeight;
      setShowLatest(false);
    }
  }, [session.messages.length, session.activity.length, session.messages, session.pendingText, session.pendingQuestions?.length, session.approvalPending]);

  const handleScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
    setShowLatest(!followLatest.current);
  };

  const isWorking = session.status === "running" || session.status === "waiting";
  const draftText = session.status === "running" ? visibleAgentDraft(session.pendingText) : "";

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="agent-code-scroll h-0 min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full w-full max-w-[820px] flex-col gap-5 px-6 pb-12 pt-6">
          {entries.map((entry, index) => (
            <motion.div key={entry.key} className="shrink-0" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: Math.min(index * 0.012, 0.12) }}>
              {entry.type === "compaction"
                ? <details className="rounded-xl border border-outline-variant bg-surface-container-low px-3.5 py-2.5 text-on-surface">
                    <summary className="cursor-pointer font-label-sm text-label-sm">Context compacted</summary>
                    <pre className="mt-2 whitespace-pre-wrap font-body-sm text-body-sm text-secondary">{session.contextSummary}</pre>
                  </details>
                : entry.type === "message"
                ? <MessageItem message={session.messages[entry.index]} showHeader={false} />
                : entry.type === "activity"
                  ? <ToolRow item={session.activity[entry.index]} repeatCount={entry.repeatCount} />
                  : <div className="flex items-center gap-2.5 py-1 pl-1" role={entry.current ? "status" : undefined} aria-live={entry.current ? "polite" : undefined}>
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10">
                        {entry.current && isWorking ? <Loader2 size={13} className="animate-spin text-primary" /> : <Logo className="h-4 w-4" />}
                      </span>
                      <span className="font-label-sm text-label-sm text-secondary">Agent{entry.current && session.progressMessage ? ` · ${session.progressMessage}${session.progressUntil ? ` (${Math.max(0, Math.ceil((session.progressUntil - clock) / 1000))}s)` : ""}` : ""}</span>
                    </div>}
            </motion.div>
          ))}
          {draftText && (
            <motion.div className="shrink-0" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}>
              <MessageItem
                message={{ id: `draft-${session.id}`, role: "assistant", content: draftText, status: "streaming", timestamp: session.updatedAt, fileRefs: [] }}
                showHeader={false}
              />
            </motion.div>
          )}
          {showQuestions && (
            <motion.div className="shrink-0" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}>
              <QuestionCard questions={session.pendingQuestions ?? []} onSubmit={answerQuestions} />
            </motion.div>
          )}
          {showPlanActions && (
            <motion.div className="flex shrink-0 flex-wrap gap-2" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}>
              <button
                type="button"
                onClick={approvePlan}
                className="flex cursor-pointer items-center gap-1.5 rounded-full bg-primary px-4 py-2 font-label-sm text-label-sm font-medium text-on-primary hover:opacity-90"
              >
                <Check size={13} /> Approve & continue
              </button>
              <button
                type="button"
                onClick={continuePlan}
                className="flex cursor-pointer items-center gap-1.5 rounded-full border border-primary/40 px-4 py-2 font-label-sm text-label-sm font-medium text-primary hover:bg-primary/5"
              >
                <Play size={13} /> Continue plan
              </button>
            </motion.div>
          )}
        </div>
      </div>
      {showLatest && (
        <button type="button" onClick={() => { const element = scrollRef.current; if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" }); followLatest.current = true; setShowLatest(false); }} className="absolute bottom-3 right-4 z-10 flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container-high px-3 py-1.5 font-label-xs text-label-xs text-on-surface shadow-lg hover:bg-surface-container-highest" aria-label="Jump to latest response">
          <ArrowDownToLine size={13} /> Latest
        </button>
      )}
    </div>
  );
}
