import { MessageSquare, Search, Sparkles } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { siteById } from "@/Browser/browserSites";
import { BROWSER_MODEL_META } from "@/Browser/browserModelMeta";
import { BRAND_ACCENT, BRAND_TINT, BrandIcon } from "@/Browser/components/brand-icons";
import { requestAssistantGuide } from "@/RightPanel/AssistantGuide";
import { useBrowserStore } from "@/Browser/browserStore";
import ModelStrengthsBanner from "@/Browser/components/model-strengths-banner";
import type { BrowserSiteId } from "../../../../shared/ipc-types";

/**
 * Full-panel welcome shown for a model before the first message. Hero (brand
 * tinted), "good at" chips, example prompts, a rotating suggestion banner for
 * the other models, and See more / Chat actions. The composer lives below in
 * BrowserChatPanel, so the user can also just start typing.
 */
export default function ModelWelcome({
  siteId,
  onExample,
  onChat
}: {
  siteId: BrowserSiteId;
  onExample: (text: string) => void;
  onChat: () => void;
}): React.JSX.Element | null {
  const site = siteById(siteId);
  const meta = BROWSER_MODEL_META[siteId];
  const selectSite = useBrowserStore((state) => state.selectSite);
  if (!site || !meta) return null;
  const accent = BRAND_ACCENT[siteId];

  return (
    <div className="flex flex-col gap-3">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-low p-5">
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: `radial-gradient(120% 120% at 100% 0%, ${accent.tint} 0%, transparent 58%)` }}
        />
        <div className="relative flex items-start gap-3.5">
          <span
            className={cn("flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl", BRAND_TINT[siteId])}
            style={{ boxShadow: `0 8px 24px -12px ${accent.glow}` }}
          >
            <BrandIcon id={siteId} size={30} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-headline-sm text-headline-sm font-semibold text-on-surface">{site.label}</h2>
              {meta.chatOnly && (
                <span className="shrink-0 rounded-full bg-editor-text-dim/10 px-2 py-0.5 font-label-xs text-label-xs font-medium text-editor-text-dim">
                  Chat only
                </span>
              )}
            </div>
            <p className="mt-0.5 font-body-sm text-body-sm text-secondary">{meta.tagline}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {meta.bestFor.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full px-2 py-0.5 font-label-xs text-label-xs font-medium"
                  style={{ backgroundColor: accent.tint, color: accent.accent }}
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        <p className="relative mt-3.5 font-body-sm text-body-sm leading-relaxed text-secondary">{meta.useWhen}</p>

        <div className="relative mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onChat}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 font-label-sm text-label-sm font-medium text-on-primary transition-opacity hover:opacity-90"
          >
            <MessageSquare size={14} />
            Chat
          </button>
          <button
            type="button"
            onClick={() => requestAssistantGuide(siteId)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest px-3.5 py-2 font-label-sm text-label-sm font-medium text-on-surface transition-colors hover:bg-surface-container"
          >
            <Search size={13} />
            See more
          </button>
        </div>
      </div>

      {/* Example prompts */}
      <div className="flex flex-col gap-1.5">
        <p className="px-1 font-label-xs text-label-xs font-semibold uppercase tracking-wider text-editor-text-dim">
          Start with an example
        </p>
        {meta.examplePrompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onExample(prompt)}
            className="group flex items-center gap-2.5 rounded-xl border border-outline-variant/70 bg-surface-container-lowest px-3 py-2.5 text-left transition-colors hover:border-outline hover:bg-surface-container"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-container-high text-secondary transition-colors group-hover:text-primary">
              <Sparkles size={13} />
            </span>
            <span className="min-w-0 flex-1 truncate font-body-sm text-body-sm text-on-surface">{prompt}</span>
          </button>
        ))}
      </div>

      {/* Other models */}
      <ModelStrengthsBanner exclude={siteId} onSelect={(id) => void selectSite(id)} />
    </div>
  );
}
