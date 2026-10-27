import { useState, useRef, useCallback, useEffect } from "react";
import { Send, Square, Paperclip, ChevronDown, Check } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useAgentStore } from "../../agentStore";
import { AGENT_MODES } from "../../data/modes";
import Logo from "@/Workspace/components/logo";
import type { AgentMode } from "../../types";

export default function PromptArea() {
  const value = useAgentStore((s) => s.draft);
  const setValue = useAgentStore((s) => s.setDraft);
  const mode = useAgentStore((s) => s.mode);
  const setMode = useAgentStore((s) => s.setMode);
  const [modeOpen, setModeOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const session = useAgentStore((s) => s.activeSession());
  const isRunning = session?.status === "running" || session?.status === "waiting";
  const sendMessage = useAgentStore((s) => s.sendMessage);
  const stopTask = useAgentStore((s) => s.stopTask);
  const resetStuck = useAgentStore((s) => s.resetStuck);

  const currentMode = AGENT_MODES.find((m) => m.id === mode) ?? AGENT_MODES[0];
  const CurrentIcon = currentMode.icon;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  useEffect(() => { adjustHeight(); }, [value, adjustHeight]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setModeOpen(false);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = () => {
    if (!value.trim() || isRunning) return;
    const text = value;
    setValue("");
    sendMessage(text, mode);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.focus();
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  return (
    <div
      className="relative shrink-0 px-4 pb-3 pt-1"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border border-dashed border-outline bg-background/90">
          <span className="font-label-sm text-label-sm text-secondary">Drop files to attach</span>
        </div>
      )}

      <div className="mx-auto w-full max-w-[760px]">
        {/* Send box — outlined, transparent fill */}
        <div
          className={cn(
            "rounded-2xl border bg-surface-container-low/70 shadow-sm transition-colors",
            dragOver ? "border-primary/60" : "border-outline-variant focus-within:border-primary/55"
          )}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? "Send a follow-up…" : "Describe a task…"}
            rows={2}
            className="w-full resize-none bg-transparent px-4 py-3 font-body-md text-body-md text-on-surface placeholder-secondary focus:outline-none"
          />

          <div className="flex items-center justify-between border-t border-outline-variant/70 px-2 py-1.5">
            {/* Mode dropdown */}
            <div className="flex items-center gap-2">
              <Logo className="h-4 w-4" />
              <span className="font-label-xs text-label-xs text-secondary">Xvie Agent</span>
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => setModeOpen(!modeOpen)}
                className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-on-surface transition-colors hover:bg-surface-container-low"
              >
                <CurrentIcon size={12} className="text-secondary" />
                <span className="font-label-xs text-label-xs font-medium">{currentMode.label}</span>
                <ChevronDown
                  size={11}
                  className={cn("text-secondary transition-transform", modeOpen && "rotate-180")}
                />
              </button>

              {modeOpen && (
                <>
                  <button
                    type="button"
                    className="fixed inset-0 z-40 cursor-default"
                    onClick={() => setModeOpen(false)}
                    aria-label="Close mode menu"
                  />
                  {/* Opens upward — composer sits at the bottom of the panel */}
                  <div className="absolute bottom-full left-0 z-50 mb-1.5 w-60 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest p-1 shadow-lg">
                    {AGENT_MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setMode(m.id as AgentMode);
                          setModeOpen(false);
                        }}
                        className={cn(
                          "flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-container",
                          mode === m.id && "bg-surface-container-low"
                        )}
                      >
                        <m.icon size={14} className="mt-0.5 shrink-0 text-secondary" />
                        <span className="flex-1">
                          <span className="block font-label-sm text-label-sm text-on-surface">{m.label}</span>
                          <span className="block font-label-xs text-label-xs text-secondary">{m.description}</span>
                        </span>
                        {mode === m.id && <Check size={13} className="mt-0.5 shrink-0 text-on-surface" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Attach + send */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="flex cursor-pointer items-center rounded-md px-1.5 py-1 text-secondary transition-colors hover:bg-surface-container-low hover:text-on-surface"
                title="Attach file"
              >
                <Paperclip size={13} />
              </button>

              {isRunning ? (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={stopTask}
                    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-outline-variant text-on-surface transition-colors hover:bg-surface-container-low"
                    title="Stop"
                  >
                    <Square size={11} fill="currentColor" />
                  </button>
                  <button
                    type="button"
                    onClick={resetStuck}
                    className="cursor-pointer rounded px-1 py-0.5 font-label-xs text-label-xs text-secondary hover:text-on-surface"
                    title="Force-unlock the send box if Stop does nothing (stuck run)"
                  >
                    Reset
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!value.trim()}
                  className={cn(
                    "flex h-7 w-7 cursor-pointer items-center justify-center rounded-full transition-colors",
                    value.trim()
                      ? "bg-primary text-on-primary hover:opacity-90"
                      : "bg-surface-container-high text-secondary cursor-not-allowed"
                  )}
                  title="Send"
                >
                  <Send size={13} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
