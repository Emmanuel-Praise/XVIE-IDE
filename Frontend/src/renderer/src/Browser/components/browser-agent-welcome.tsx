import { Sparkles } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { AGENT_MODES } from "@/Agent/data/modes";
import { BrandIcon } from "@/Browser/components/brand-icons";
import { BROWSER_SITES } from "@/Browser/browserSites";
import type { AgentMode } from "@/Agent/types";
import type { BrowserSiteId } from "../../../../shared/ipc-types";

/**
 * Welcome shown inside the Browser Agent panel before the first run. Leads
 * with what the orchestrator does, then the five modes as selectable cards.
 */
export default function BrowserAgentWelcome({
  mode,
  coordinator,
  onSelectMode
}: {
  mode: AgentMode;
  coordinator: BrowserSiteId;
  onSelectMode: (mode: AgentMode) => void;
}): React.JSX.Element {
  const coordinatorLabel = BROWSER_SITES.find((site) => site.id === coordinator)?.label ?? "the coordinator";
  const current = AGENT_MODES.find((item) => item.id === mode);

  return (
    <div className="flex flex-col gap-3">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-low p-4">
        <div className="pointer-events-none absolute inset-0 opacity-70" style={{ background: "radial-gradient(120% 120% at 100% 0%, color-mix(in srgb, var(--primary) 22%, transparent) 0%, transparent 58%)" }} />
        <div className="relative flex items-start gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Sparkles size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-headline-sm text-headline-sm font-semibold text-on-surface">Browser Agent</h2>
            <p className="mt-0.5 font-body-sm text-body-sm text-secondary">
              A coordinator model plans and saves edits; optional workers review broad tasks. Uses your logged-in browser tabs — no API key.
            </p>
            <p className="mt-2 flex items-center gap-1.5 font-label-xs text-label-xs text-editor-text-dim">
              <BrandIcon id={coordinator} size={13} />
              Coordinator: <span className="text-on-surface">{coordinatorLabel}</span>
            </p>
          </div>
        </div>
      </div>

      {/* Modes */}
      <div>
        <p className="mb-1.5 px-1 font-label-xs text-label-xs font-semibold uppercase tracking-wider text-editor-text-dim">
          Choose a mode
        </p>
        <div className="grid grid-cols-2 gap-2">
          {AGENT_MODES.map((item) => {
            const active = mode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                onClick={() => onSelectMode(item.id)}
                className={cn(
                  "group flex flex-col gap-1 rounded-xl border p-3 text-left transition-all",
                  active
                    ? "border-primary/50 bg-primary/10"
                    : "border-outline-variant/70 bg-surface-container-lowest hover:border-outline hover:bg-surface-container"
                )}
              >
                <span className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
                  active ? "bg-primary text-on-primary" : "bg-surface-container-high text-secondary group-hover:text-primary"
                )}>
                  <item.icon size={13} />
                </span>
                <span className="mt-0.5 font-label-sm text-label-sm font-semibold text-on-surface">{item.label}</span>
                <span className="font-label-xs text-label-xs leading-snug text-secondary">{item.description}</span>
              </button>
            );
          })}
        </div>
        {current && (
          <p className="mt-1.5 px-1 font-label-xs text-label-xs text-secondary">
            <span className="text-primary">{current.label}</span> mode selected — type your task below.
          </p>
        )}
      </div>
    </div>
  );
}
