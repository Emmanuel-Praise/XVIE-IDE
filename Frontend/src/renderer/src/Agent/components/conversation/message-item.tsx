import { useEffect, useState } from "react";
import { ChevronDown, Copy, Check, RefreshCw, ThumbsUp, ThumbsDown, Wrench, TriangleAlert } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import Logo from "@/Workspace/components/logo";
import type { ActivityItem, Message } from "../../types";
import MessageMarkdown from "./message-markdown";
import FileReference from "./file-reference";
import ToolRow from "./tool-row";
import { formatDuration } from "../../data/stage-utils";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function TurnMeta({ label, ts }: { label: string; ts: number }) {
  return (
    <span className="font-label-xs text-label-xs text-secondary">
      {label} · {formatTime(ts)}
    </span>
  );
}

/* ---------- Work card: one collapsible card holding all tool rows ---------- */

export function WorkCard({ work }: { work: ActivityItem[] }) {
  const hasRunning = work.some((w) => w.status === "running");
  const [open, setOpen] = useState(hasRunning);

  /* Live while working, tuck away once the reply starts. */
  useEffect(() => {
    if (hasRunning) setOpen(true);
    else setOpen(false);
  }, [hasRunning]);

  const durationMs =
    work.length > 0 ? work[work.length - 1].timestamp - work[0].timestamp + 1200 : 0;

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-container-low"
      >
        {hasRunning ? (
          <span className="agent-tool-spin" aria-hidden />
        ) : (
          <Wrench size={12} className="shrink-0 text-secondary" />
        )}
        <span className="font-label-xs text-label-xs text-on-surface">
          {hasRunning ? "Working…" : "Worked"}
          {durationMs > 0 && !hasRunning ? ` for ${formatDuration(durationMs)}` : ""}
          {` · ${work.length} step${work.length === 1 ? "" : "s"}`}
        </span>
        <span className="flex-1" />
        <ChevronDown
          size={13}
          className={cn("shrink-0 text-secondary transition-transform", !open && "-rotate-90")}
        />
      </button>

      {open && (
        <div className="border-t border-outline-variant/70 px-3 py-1.5">
          {work.map((item) => (
            <ToolRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Main message renderer ---------- */

interface MessageItemProps {
  message: Message;
  showHeader?: boolean;
  /** Tool activity that belongs to this turn (agent turns only). */
  work?: ActivityItem[];
}

export default function MessageItem({ message, work, showHeader = true }: MessageItemProps) {
  const [copied, setCopied] = useState(false);
  const [voted, setVoted] = useState<"up" | "down" | null>(null);

  const copy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /* ---------- USER — soft right-aligned bubble ---------- */
  if (message.role === "user") {
    const sending = message.status === "streaming";
    return (
      <div className="flex justify-end">
        <div className="agent-user-bubble max-w-[85%] rounded-2xl rounded-br-sm px-3.5 py-2.5">
          <p className="whitespace-pre-wrap font-body-md text-body-md text-on-surface">
            {message.content}
            {sending && <span className="agent-caret" />}
          </p>
        </div>
      </div>
    );
  }

  /* ---------- SYSTEM — centered divider ---------- */
  if (message.role === "system") {
    return (
      <div className="flex items-center gap-3 py-1">
        <span className="h-px flex-1 bg-outline-variant" />
        <span className="font-label-xs text-label-xs uppercase tracking-wider text-secondary">
          {message.content}
        </span>
        <span className="h-px flex-1 bg-outline-variant" />
      </div>
    );
  }

  /* ---------- ASSISTANT — logo chip turn ---------- */
  const streaming = message.status === "streaming";

  return (
    <div className="group agent-answer">
      {showHeader && <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full border border-primary/30 bg-primary/10">
          <Logo className="h-3.5 w-3.5" />
        </span>
        <TurnMeta label="Agent" ts={message.timestamp} />
      </div>}

      <div className={showHeader ? "mt-1.5 pl-7" : "mt-0 pl-0"}>
        {work && work.length > 0 && (
          <>
            {work.filter((w) => w.kind === "think").map((item) => (
              <ToolRow key={item.id} item={item} />
            ))}
            {(() => {
              const rest = work.filter((w) => w.kind !== "think");
              return rest.length > 0 ? <WorkCard work={rest} /> : null;
            })()}
          </>
        )}

        {message.status === "incomplete" && (
          <div role="status" className="mb-2 flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 font-label-xs text-label-xs text-amber-800 dark:text-amber-300">
            <TriangleAlert size={13} aria-hidden />
            <span>Incomplete response — some output may be missing.</span>
          </div>
        )}

        {message.content && (
          <div className={cn(work && work.length > 0 && "mt-3")}>
            <MessageMarkdown content={message.content} />
            {streaming && <span className="agent-caret" />}
          </div>
        )}

        {message.fileRefs.length > 0 && (
          <div className="mt-2">
            <FileReference refs={message.fileRefs} />
          </div>
        )}

        {message.status === "done" && (
          <div className="flex items-center gap-0.5 pt-1.5 text-secondary opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              onClick={copy}
              className="cursor-pointer rounded-md p-1.5 transition-colors hover:bg-surface-container hover:text-on-surface"
              title={copied ? "Copied" : "Copy"}
            >
              {copied ? <Check size={13} className="text-green-600 dark:text-green-500" /> : <Copy size={13} />}
            </button>
            <button
              type="button"
              className="cursor-pointer rounded-md p-1.5 transition-colors hover:bg-surface-container hover:text-on-surface"
              title="Regenerate"
            >
              <RefreshCw size={13} />
            </button>
            <span className="mx-0.5 h-4 w-px bg-outline-variant" />
            <button
              type="button"
              onClick={() => setVoted(voted === "up" ? null : "up")}
              className={cn(
                "cursor-pointer rounded-md p-1.5 transition-colors hover:bg-surface-container",
                voted === "up" ? "text-green-600 dark:text-green-500" : "hover:text-on-surface"
              )}
              title="Good response"
            >
              <ThumbsUp size={13} />
            </button>
            <button
              type="button"
              onClick={() => setVoted(voted === "down" ? null : "down")}
              className={cn(
                "cursor-pointer rounded-md p-1.5 transition-colors hover:bg-surface-container",
                voted === "down" ? "text-red-600 dark:text-red-500" : "hover:text-on-surface"
              )}
              title="Poor response"
            >
              <ThumbsDown size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
