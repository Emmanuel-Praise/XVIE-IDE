import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { BROWSER_SITES } from "@/Browser/browserSites";
import { BrandIcon, BRAND_TINT } from "@/Browser/components/brand-icons";
import Logo from "@/Workspace/components/logo";
import { cn } from "@/shared/lib/utils";
import { useAgentStore } from "@/Agent/agentStore";
import { useBrowserStore } from "@/Browser/browserStore";
import { BROWSER_MODEL_META } from "@/Browser/browserModelMeta";
import { ASSISTANT_RAIL_HELP } from "./AssistantGuide";
import { useRightPanelStore } from "./rightPanelStore";

export default function RightPanelRail() {
  const view = useRightPanelStore((state) => state.view);
  const setView = useRightPanelStore((state) => state.setView);
  const activeSiteId = useBrowserStore((state) => state.activeSiteId);
  const selectSite = useBrowserStore((state) => state.selectSite);
  const status = useAgentStore((state) => state.activeSession()?.status);
  const working = status === "running";
  const waiting = status === "waiting";

  return (
    <aside aria-label="AI assistants" className="z-30 flex w-12 shrink-0 flex-col items-center gap-1 border-l border-outline-variant bg-surface-container-lowest py-2">
      <button
        type="button"
        onClick={() => setView("agent")}
        title={ASSISTANT_RAIL_HELP.agent.title}
        aria-label="Open Xvie Agent"
        aria-description={ASSISTANT_RAIL_HELP.agent.detail}
        aria-pressed={view === "agent"}
        className={cn("group relative flex h-9 w-9 items-center justify-center rounded-xl transition-colors hover:bg-surface-container-low", view === "agent" ? "bg-primary/10" : "bg-transparent")}
      >
        {(working || waiting) && <span className="absolute inset-0 rounded-xl animate-pulse ring-1 ring-outline-variant" />}
        <motion.span
          className="relative flex"
          animate={working ? { y: [0, -2, 0], rotate: [0, -4, 4, 0] } : { y: 0, rotate: 0 }}
          transition={working ? { duration: 1.1, repeat: Infinity, ease: "easeInOut" } : { duration: 0.16 }}
        >
          <Logo className="h-6 w-6" />
        </motion.span>
        {waiting && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-500" />}
      </button>
      <button
        type="button"
        onClick={() => setView("browser-agent")}
        title={ASSISTANT_RAIL_HELP["browser-agent"].title}
        aria-label="Open Browser Agent"
        aria-description={ASSISTANT_RAIL_HELP["browser-agent"].detail}
        aria-pressed={view === "browser-agent"}
        className={cn("flex h-9 w-9 items-center justify-center rounded-xl transition-colors hover:bg-surface-container-low", view === "browser-agent" ? "bg-primary/10 text-primary" : "text-secondary")}
      >
        <Sparkles size={18} />
      </button>
      <span className="my-1 h-px w-7 bg-outline-variant" />
      {BROWSER_SITES.map((site) => {
        const meta = BROWSER_MODEL_META[site.id];
        return (
        <button
          key={site.id}
          type="button"
          onClick={() => { setView("browser"); if (activeSiteId !== site.id) void selectSite(site.id); }}
          title={meta ? `${site.label} — ${meta.useWhen}` : site.label}
          aria-label={`Open ${site.label}`}
          aria-pressed={view === "browser" && activeSiteId === site.id}
          className={cn("flex h-9 w-9 items-center justify-center rounded-xl transition-transform hover:scale-110 hover:bg-surface-container-low", BRAND_TINT[site.id].split(" ").find((token) => token.startsWith("text-")), view === "browser" && activeSiteId === site.id ? "bg-primary/10 ring-1 ring-primary/25" : "bg-transparent")}
        >
          <BrandIcon id={site.id} size={17} />
        </button>
        );
      })}
    </aside>
  );
}
