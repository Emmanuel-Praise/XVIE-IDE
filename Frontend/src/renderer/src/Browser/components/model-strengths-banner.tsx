import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { BROWSER_SITES } from "@/Browser/browserSites";
import { BROWSER_MODEL_META } from "@/Browser/browserModelMeta";
import { BRAND_ACCENT, BRAND_TINT, BrandIcon } from "@/Browser/components/brand-icons";
import type { BrowserSiteId } from "../../../../shared/ipc-types";

const ROTATE_MS = 5000;

/**
 * Auto-rotating (and manually controllable) strip that advertises the *other*
 * models while the user looks at one model's welcome. Click a suggestion to
 * jump straight to that model's welcome.
 */
export default function ModelStrengthsBanner({
  exclude,
  onSelect
}: {
  exclude: BrowserSiteId;
  onSelect: (id: BrowserSiteId) => void;
}): React.JSX.Element | null {
  const others = useMemo(() => BROWSER_SITES.filter((site) => site.id !== exclude), [exclude]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    setIndex(0);
  }, [exclude]);

  useEffect(() => {
    if (reduce || paused || others.length < 2) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % others.length), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [others.length, paused, reduce]);

  if (others.length === 0) return null;
  const site = others[index % others.length];
  const meta = BROWSER_MODEL_META[site.id];
  if (!meta) return null;
  const accent = BRAND_ACCENT[site.id];

  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-low"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: `radial-gradient(130% 130% at 100% 0%, ${accent.tint} 0%, transparent 62%)` }}
      />
      <div className="relative flex items-center gap-3 px-3 py-2.5">
        <span className="hidden shrink-0 font-label-xs text-label-xs font-semibold uppercase tracking-wider text-editor-text-dim sm:block">
          Try next
        </span>
        <div className="relative min-w-0 flex-1">
          <AnimatePresence mode="wait" initial={false}>
            <motion.button
              key={site.id}
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: reduce ? 0 : 0.28, ease: "easeOut" }}
              onClick={() => onSelect(site.id)}
              className="flex w-full min-w-0 items-center gap-2.5 text-left"
            >
              <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", BRAND_TINT[site.id])}>
                <BrandIcon id={site.id} size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-label-sm text-label-sm font-semibold text-on-surface">
                  Use {site.label}
                </span>
                <span className="block truncate font-label-xs text-label-xs text-secondary">{meta.useWhen}</span>
              </span>
              <ArrowRight size={14} className="shrink-0 text-editor-text-dim" />
            </motion.button>
          </AnimatePresence>
        </div>
        <div className="flex shrink-0 items-center gap-1" role="tablist" aria-label="Other model suggestions">
          {others.map((other, dotIndex) => (
            <button
              key={other.id}
              type="button"
              role="tab"
              aria-selected={dotIndex === index}
              aria-label={`Show ${other.label}`}
              onClick={() => setIndex(dotIndex)}
              className={cn(
                "h-1.5 cursor-pointer rounded-full transition-all",
                dotIndex === index ? "w-4" : "w-1.5 bg-outline-variant hover:bg-editor-text-dim/50"
              )}
              style={dotIndex === index ? { backgroundColor: accent.accent } : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
