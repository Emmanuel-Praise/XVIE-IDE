import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CircleHelp, PanelRightClose, Settings2, Square, Plus, History, Sparkles } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useRightPanelStore } from "./rightPanelStore";
import { useAgentStore } from "@/Agent/agentStore";
import { useBrowserStore } from "@/Browser/browserStore";
import BrowserChatPanel from "@/Browser/components/browser-chat-panel";
import BrowserAgentWorkflow from "@/Browser/components/browser-agent-workflow";
import ConversationWorkspace from "@/Agent/components/conversation/conversation-workspace";
import PromptArea from "@/Agent/components/prompt/prompt-area";
import PlanPanel from "@/Agent/components/sidebar/plan-panel";
import ProviderSettings from "@/Agent/components/settings/provider-settings";
import NotificationToasts from "@/Agent/components/notifications/notification-toasts";
import HistoryPanel from "@/Agent/components/sidebar/history-panel";
import AgentDockWelcome from "@/Agent/components/welcome/agent-dock-welcome";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import Logo from "@/Workspace/components/logo";
import { BrandIcon } from "@/Browser/components/brand-icons";
import { siteById } from "@/Browser/browserSites";
import { AssistantSheet, requestAssistantGuide } from "./AssistantGuide";

function AgentDockView() {
  const session = useAgentStore((state) => state.activeSession());
  const newTask = useAgentStore((state) => state.newTask);
  const stopTask = useAgentStore((state) => state.stopTask);
  const refreshProviders = useAgentStore((state) => state.refreshProviders);
  const loadSessions = useAgentStore((state) => state.loadSessions);
  const setWorkspaceScope = useAgentStore((state) => state.setWorkspaceScope);
  const workspacePath = useFileSystemStore((state) => state.workspace?.path);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => { void refreshProviders(); }, [refreshProviders]);
  useEffect(() => {
    setWorkspaceScope(workspacePath ?? null);
    if (workspacePath) void loadSessions();
  }, [loadSessions, setWorkspaceScope, workspacePath]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-outline-variant px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", session?.status === "running" ? "animate-pulse bg-green-500" : session?.status === "waiting" ? "animate-pulse bg-amber-500" : "bg-primary/70")} />
          <span className="truncate font-label-sm text-label-sm font-medium text-on-surface">{session?.title ?? "New task"}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {(session?.status === "running" || session?.status === "waiting") && (
            <button type="button" onClick={stopTask} title="Stop agent" aria-label="Stop agent" className="rounded-md p-1.5 text-secondary hover:bg-surface-container-low hover:text-red-500"><Square size={12} fill="currentColor" /></button>
          )}
          <button type="button" onClick={newTask} title="New task" aria-label="New task" className="rounded-md p-1.5 text-secondary hover:bg-surface-container-low hover:text-on-surface"><Plus size={14} /></button>
          <button type="button" onClick={() => setHistoryOpen((open) => !open)} title="Session history" aria-label="Session history" aria-expanded={historyOpen} className={cn("rounded-md p-1.5 hover:bg-surface-container-low hover:text-on-surface", historyOpen ? "text-primary" : "text-secondary")}><History size={14} /></button>
          <button type="button" onClick={() => setSettingsOpen(true)} title="Provider settings" aria-label="Provider settings" className="rounded-md p-1.5 text-secondary hover:bg-surface-container-low hover:text-on-surface"><Settings2 size={14} /></button>
        </div>
      </header>
      {session?.status === "running" && (
        <div className="shrink-0 border-b border-outline-variant/70 px-3 py-2" role="status" aria-live="polite">
          <div className="mb-1.5 flex items-center gap-2">
            <motion.span className="h-1.5 w-1.5 rounded-full bg-primary" animate={{ scale: [1, 1.45, 1], opacity: [0.65, 1, 0.65] }} transition={{ duration: 1.3, repeat: Infinity }} />
            <span className="truncate font-label-xs text-label-xs text-secondary">{session.progressMessage ?? "Working on your request"}</span>
          </div>
          <motion.div className="h-0.5 origin-left rounded-full bg-primary/70" initial={{ scaleX: 0.08 }} animate={{ scaleX: [0.2, 0.75, 0.42, 0.9] }} transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }} />
        </div>
      )}
      <AnimatePresence initial={false}>
        {historyOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="shrink-0 overflow-hidden border-b border-outline-variant">
            <div className="max-h-48 overflow-y-auto px-3 py-2"><HistoryPanel compact /></div>
          </motion.div>
        )}
      </AnimatePresence>
      {session?.approvalPending && (
        <div className="max-h-40 shrink-0 overflow-y-auto border-b border-outline-variant p-3"><PlanPanel /></div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {session ? <ConversationWorkspace session={session} /> : <AgentDockWelcome />}
      </div>
      <PromptArea />
      <ProviderSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

export default function RightPanelDock() {
  const open = useRightPanelStore((state) => state.open);
  const view = useRightPanelStore((state) => state.view);
  const width = useRightPanelStore((state) => state.width);
  const setWidth = useRightPanelStore((state) => state.setWidth);
  const setOpen = useRightPanelStore((state) => state.setOpen);
  const activeSiteId = useBrowserStore((state) => state.activeSiteId);
  const activeSite = siteById(activeSiteId);
  const selectSite = useBrowserStore((state) => state.selectSite);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);

  // The browser surface always has a model: the chooser is gone, so fall back
  // to the default model if the view is opened without one.
  useEffect(() => {
    if (view === "browser" && !activeSiteId) void selectSite("chatgpt");
  }, [view, activeSiteId, selectSite]);

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    resizeStart.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizeStart.current) return;
    setWidth(resizeStart.current.width + resizeStart.current.x - event.clientX);
  };
  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    resizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <>
      <AnimatePresence initial={false}>
        {open && (
          <motion.aside
          key="right-panel-dock"
          initial={{ width: 0, opacity: 0 }} animate={{ width, opacity: 1 }} exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="relative z-20 flex h-full min-h-0 min-w-0 max-w-[min(760px,calc(100vw-4rem))] shrink-0 flex-col overflow-hidden border-l border-outline-variant bg-surface-container-lowest"
          aria-label="Right side panel"
        >
          <div role="separator" aria-orientation="vertical" aria-label="Resize right sidebar" aria-valuemin={340} aria-valuemax={760} aria-valuenow={width} tabIndex={0} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth(width + (event.key === "ArrowLeft" ? 24 : -24)); } }} onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} className="absolute inset-y-0 left-0 z-30 w-1.5 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/50 focus-visible:bg-primary/70" />
          <header className="flex h-11 shrink-0 items-center justify-between border-b border-outline-variant px-3">
            <div className="flex min-w-0 items-center gap-2">
              {view === "agent" ? <Logo className="h-5 w-5" /> : view === "browser-agent" ? <span className="text-primary"><Sparkles size={16} /></span> : activeSite ? <BrandIcon id={activeSite.id} size={16} /> : null}
              <span className="truncate font-label-sm text-label-sm font-semibold text-on-surface">
                {view === "agent" ? "Xvie Agent" : view === "browser-agent" ? "Browser Agent" : activeSite?.label ?? "Browser Models"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {view === "browser" && !activeSite && (
                <button type="button" onClick={() => requestAssistantGuide()} title="Which assistant do I need?" aria-label="Which assistant do I need?" className="rounded-md p-1.5 text-secondary hover:bg-surface-container-low hover:text-on-surface"><CircleHelp size={14} /></button>
              )}
              <button type="button" onClick={() => setOpen(false)} title="Close right panel" aria-label="Close right panel" className="rounded-md p-1.5 text-secondary hover:bg-surface-container-low hover:text-on-surface"><PanelRightClose size={14} /></button>
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {view === "agent" ? <AgentDockView /> : view === "browser-agent" ? <BrowserAgentWorkflow /> : activeSiteId ? <BrowserChatPanel /> : null}
          </div>
          <AssistantSheet />
          </motion.aside>
        )}
      </AnimatePresence>
      <NotificationToasts />
    </>
  );
}
