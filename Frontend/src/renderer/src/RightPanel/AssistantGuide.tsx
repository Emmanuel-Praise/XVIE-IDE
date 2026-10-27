import { useEffect, useRef, useState } from "react";
import { Bot, MessagesSquare, Sparkles, X } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import Logo from "@/Workspace/components/logo";
import { useRightPanelStore } from "./rightPanelStore";
import { useBrowserStore } from "@/Browser/browserStore";
import { BROWSER_SITES } from "@/Browser/browserSites";
import { BROWSER_MODEL_META } from "@/Browser/browserModelMeta";
import { BRAND_TINT, BrandIcon } from "@/Browser/components/brand-icons";
import type { BrowserSiteId } from "../../../shared/ipc-types";

export type AssistantSheetTarget = "agent" | "browser-agent" | "browser" | BrowserSiteId;

/** Dispatched to open the assistant/model sheet, optionally deep-linked. */
export const ASSISTANT_GUIDE_OPEN_EVENT = "xvie:open-assistant-guide";

export function requestAssistantGuide(target?: AssistantSheetTarget): void {
  window.dispatchEvent(new CustomEvent(ASSISTANT_GUIDE_OPEN_EVENT, { detail: { target } }));
}

/** Rich rail/tooltip copy for the three assistant surfaces. */
export const ASSISTANT_RAIL_HELP: Record<string, { title: string; detail: string }> = {
  agent: {
    title: "Xvie Agent — edits your project directly",
    detail: "Native API agent with Plan / Ask / Code / Debug / Brainstorm modes. Needs a provider key in settings.",
  },
  "browser-agent": {
    title: "Browser Agent — web LLMs that edit your project",
    detail: "A coordinator model plans and saves edits; up to 2 workers review. Uses your logged-in browser tabs, no API key.",
  },
  browser: {
    title: "Single-site chat — quick Q&A with one model",
    detail: "Chat with ChatGPT, Claude, Gemini, DeepSeek, Grok, Qwen, or Perplexity. Attach open files for context.",
  },
};

const ASSISTANT_ONELINERS: Record<"agent" | "browser-agent" | "browser", { title: string; line: string }> = {
  agent: { title: "Xvie Agent", line: "Direct project edits — pick a mode below." },
  "browser-agent": { title: "Browser Agent", line: "Coordinator plans, workers review, edits saved to your project." },
  browser: { title: "Single-site chats", line: "Quick questions, one model at a time — no setup." },
};

function SheetAssistantRow({
  view,
  icon,
  onOpen,
}: {
  view: "agent" | "browser-agent" | "browser";
  icon: React.ReactNode;
  onOpen: (view: "agent" | "browser-agent" | "browser") => void;
}): React.JSX.Element {
  const info = ASSISTANT_ONELINERS[view];
  const detail = ASSISTANT_RAIL_HELP[view].detail;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-outline-variant/70 bg-surface-container-lowest p-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-container-high text-on-surface">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-label-sm text-label-sm font-semibold text-on-surface">{info.title}</span>
        <span className="mt-0.5 block font-body-sm text-body-sm leading-snug text-secondary">{detail}</span>
      </span>
      <button
        type="button"
        onClick={() => onOpen(view)}
        className="shrink-0 cursor-pointer rounded-lg bg-primary px-2.5 py-1.5 font-label-xs text-label-xs font-medium text-on-primary hover:opacity-90"
      >
        Open
      </button>
    </div>
  );
}

/**
 * "See more" sheet: the assistant surfaces first, then every model with a
 * one-line summary and a Chat button. Render once (e.g. in the dock); it opens
 * on ASSISTANT_GUIDE_OPEN_EVENT.
 */
export function AssistantSheet(): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<AssistantSheetTarget | null>(null);
  const setView = useRightPanelStore((s) => s.setView);
  const selectSite = useBrowserStore((s) => s.selectSite);
  const activeSiteId = useBrowserStore((s) => s.activeSiteId);
  const targetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ target?: AssistantSheetTarget }>).detail;
      setTarget(detail?.target ?? null);
      setOpen(true);
    };
    window.addEventListener(ASSISTANT_GUIDE_OPEN_EVENT, handler);
    return () => window.removeEventListener(ASSISTANT_GUIDE_OPEN_EVENT, handler);
  }, []);

  useEffect(() => {
    if (open) targetRef.current?.scrollIntoView({ block: "center" });
  }, [open, target]);

  if (!open) return null;

  const close = (): void => {
    setOpen(false);
    setTarget(null);
  };
  const openView = (view: "agent" | "browser-agent" | "browser"): void => {
    if (view === "browser") {
      setView("browser");
      if (!activeSiteId) void selectSite("chatgpt");
    } else {
      setView(view);
    }
    close();
  };
  const chatWith = (id: BrowserSiteId): void => {
    setView("browser");
    if (activeSiteId !== id) void selectSite(id);
    close();
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-black/40" role="dialog" aria-label="Assistants and models">
      <button type="button" aria-label="Close" onClick={close} className="min-h-10 w-full shrink-0 cursor-default" />
      <div className="agent-code-scroll min-h-0 flex-1 overflow-y-auto rounded-t-2xl border-t border-outline-variant bg-surface-container-lowest p-4">
        <div className="mb-3 flex items-center gap-2">
          <Bot size={15} className="text-primary" />
          <p className="flex-1 font-label-md text-label-md font-semibold text-on-surface">Assistants & models</p>
          <button type="button" onClick={close} aria-label="Close panel" className="rounded-md p-1.5 text-secondary hover:bg-surface-container-low hover:text-on-surface">
            <X size={15} />
          </button>
        </div>

        <p className="mb-2 px-1 font-label-sm text-label-sm font-bold uppercase tracking-wider text-editor-text-dim">Assistants</p>
        <div className="mb-4 flex flex-col gap-2">
          <SheetAssistantRow view="agent" icon={<Logo className="h-5 w-5" />} onOpen={openView} />
          <SheetAssistantRow view="browser-agent" icon={<Sparkles size={16} className="text-primary" />} onOpen={openView} />
          <SheetAssistantRow view="browser" icon={<MessagesSquare size={16} />} onOpen={openView} />
        </div>

        <p className="mb-2 px-1 font-label-sm text-label-sm font-bold uppercase tracking-wider text-editor-text-dim">Models</p>
        <div className="flex flex-col gap-2 pb-2">
          {BROWSER_SITES.map((site) => {
            const meta = BROWSER_MODEL_META[site.id];
            const highlighted = target === site.id;
            return (
              <div
                key={site.id}
                ref={highlighted ? targetRef : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-xl border p-3",
                  highlighted ? "border-primary/60 bg-primary/5" : "border-outline-variant/70 bg-surface-container-lowest"
                )}
              >
                <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", BRAND_TINT[site.id])}>
                  <BrandIcon id={site.id} size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-label-sm text-label-sm font-semibold text-on-surface">{site.label}</span>
                    {meta?.chatOnly && (
                      <span className="shrink-0 rounded-full bg-editor-text-dim/10 px-1.5 py-px font-label-xs text-label-xs font-medium text-editor-text-dim">
                        Chat only
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate font-body-sm text-body-sm text-secondary">{meta?.useWhen}</span>
                </span>
                <button
                  type="button"
                  onClick={() => chatWith(site.id)}
                  className="shrink-0 cursor-pointer rounded-lg bg-primary px-2.5 py-1.5 font-label-xs text-label-xs font-medium text-on-primary hover:opacity-90"
                >
                  Chat
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default AssistantSheet;
