import { useState } from "react";
import { HelpCircle, Send } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { AgentQuestion } from "../../types";

export interface QuestionAnswers {
  id: string;
  selected: string[];
  custom_text: string;
}

export default function QuestionCard({
  questions,
  onSubmit,
}: {
  questions: AgentQuestion[];
  onSubmit: (answers: QuestionAnswers[]) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});

  if (!questions.length) return null;

  const toggle = (qid: string, label: string) => {
    setSelected((prev) => ({ ...prev, [qid]: prev[qid] === label ? "" : label }));
  };

  const handleSubmit = () => {
    onSubmit(
      questions.map((q) => ({
        id: q.id,
        selected: selected[q.id] ? [selected[q.id]] : [],
        custom_text: (custom[q.id] ?? "").trim(),
      })),
    );
  };

  return (
    <div className="rounded-2xl border border-primary/30 bg-surface-container-low p-4 shadow-sm" role="group" aria-label="Agent questions">
      <div className="mb-3 flex items-center gap-2 text-on-surface">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary">
          <HelpCircle size={14} />
        </span>
        <span className="font-label-md text-label-md font-semibold">The agent has questions for you</span>
      </div>
      <div className="flex flex-col gap-4">
        {questions.map((q) => (
          <div key={q.id} className="flex flex-col gap-2">
            {q.header ? (
              <span className="font-label-xs text-label-xs font-semibold uppercase tracking-wide text-secondary">{q.header}</span>
            ) : null}
            <p className="font-body-md text-body-md text-on-surface">{q.question}</p>
            {q.options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {q.options.map((opt) => {
                  const active = selected[q.id] === opt.label;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => toggle(q.id, opt.label)}
                      aria-pressed={active}
                      title={opt.description || opt.label}
                      className={cn(
                        "cursor-pointer rounded-full border px-3 py-1.5 text-left font-label-sm text-label-sm transition-colors",
                        active
                          ? "border-primary bg-primary text-on-primary"
                          : "border-outline-variant bg-surface-container-lowest text-on-surface hover:border-primary/50 hover:bg-primary/5",
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            )}
            {(q.allow_custom ?? true) && (
              <input
                type="text"
                value={custom[q.id] ?? ""}
                onChange={(e) => setCustom((prev) => ({ ...prev, [q.id]: e.target.value }))}
                placeholder="Or type your own answer…"
                aria-label={`Custom answer for ${q.question}`}
                className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 font-body-sm text-body-sm text-on-surface placeholder-secondary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={handleSubmit}
          className="flex cursor-pointer items-center gap-1.5 rounded-full bg-primary px-4 py-2 font-label-sm text-label-sm font-medium text-on-primary transition-opacity hover:opacity-90"
        >
          <Send size={13} /> Send answers
        </button>
      </div>
    </div>
  );
}
