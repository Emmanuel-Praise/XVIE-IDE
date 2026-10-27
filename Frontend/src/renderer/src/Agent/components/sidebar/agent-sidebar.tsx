import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Activity, History, ListChecks, PanelRightClose } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useAgentStore } from "../../agentStore";
import PlanPanel from "./plan-panel";
import HistoryPanel from "./history-panel";
import ActivityPanel from "./activity-panel";

type PanelTab = "history" | "plan" | "activity";
const TABS: Array<{ id: PanelTab; label: string; icon: typeof History }> = [
  { id: "history", label: "History", icon: History },
  { id: "plan", label: "Plan", icon: ListChecks },
  { id: "activity", label: "Activity", icon: Activity }
];
const WIDTH_KEY = "xvie-agent-sidebar-width";

function readWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value >= 260 && value <= 520 ? value : 340;
  } catch { return 340; }
}

export default function AgentSidebar() {
  const session = useAgentStore((s) => s.activeSession());
  const setSidebarOpen = useAgentStore((s) => s.setSidebarOpen);
  const [tab, setTab] = useState<PanelTab>("activity");
  const [width, setWidth] = useState(readWidth);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => { if (session?.approvalPending) setTab("plan"); }, [session?.approvalPending]);

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    resizeStart.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizeStart.current) return;
    const next = Math.max(260, Math.min(520, Math.round(resizeStart.current.width + resizeStart.current.x - event.clientX)));
    setWidth(next);
    try { localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* persistence is optional */ }
  };
  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    resizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <motion.aside initial={{ width: 0, opacity: 0 }} animate={{ width, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ duration: 0.2, ease: "easeOut" }} className="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-outline-variant bg-surface-container-lowest">
      <div role="separator" aria-orientation="vertical" aria-label="Resize Agent sidebar" aria-valuemin={260} aria-valuemax={520} aria-valuenow={width} tabIndex={0} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const next = Math.max(260, Math.min(520, width + (event.key === "ArrowLeft" ? 24 : -24))); setWidth(next); try { localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* persistence is optional */ } } }} onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} className="absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/40 focus-visible:bg-primary/60" />
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-outline-variant pl-4 pr-2">
        <div className="flex min-w-0 items-center gap-1" role="tablist" aria-label="Agent sidebar">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cn("relative flex h-8 items-center gap-1.5 rounded-md px-2 font-label-sm text-label-sm transition-colors", tab === id ? "text-on-surface" : "text-secondary hover:text-on-surface")}>
              <Icon size={13} /> {label}
              {tab === id && <motion.span layoutId="agent-sidebar-tab" className="absolute inset-x-2 -bottom-1 h-0.5 rounded-full bg-primary" transition={{ type: "spring", stiffness: 500, damping: 35 }} />}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setSidebarOpen(false)} className="rounded-md p-1.5 text-secondary hover:bg-surface-container-low hover:text-on-surface" title="Hide Agent sidebar" aria-label="Hide Agent sidebar"><PanelRightClose size={14} /></button>
      </header>

      <div key={tab} role="tabpanel" className="agent-code-scroll h-0 min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {!session && tab !== "history" ? (
          <p className="py-2 font-body-sm text-body-sm text-secondary">Start a task to see its {tab}.</p>
        ) : tab === "history" ? <HistoryPanel compact /> : tab === "plan" ? <PlanPanel /> : <ActivityPanel />}
      </div>
    </motion.aside>
  );
}
