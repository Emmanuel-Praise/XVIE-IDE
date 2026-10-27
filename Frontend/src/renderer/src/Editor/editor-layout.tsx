import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import EditorTopBar from "@/Editor/TopBar/editor-topbar";
import ActivityRail from "@/Editor/LeftSide/activity-rail";
import ExplorerPanel from "@/Editor/LeftSide/panels/explorer-panel";
import SearchPanel from "@/Editor/LeftSide/panels/search-panel";
import GitPanel from "@/Editor/LeftSide/panels/git-panel";
import MenuPanel from "@/Editor/LeftSide/panels/menu-panel";
import EditorGrid from "@/Editor/Middle/editor-grid";
import BottomTerminal from "@/Editor/Middle/bottom-terminal";
import EditorStatusBar from "@/Editor/Middle/editor-statusbar";
import { useEditorStore, type RailView } from "@/Editor/editorStore";
import { useBrowserStore } from "@/Browser/browserStore";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import { purgeAllModels, flushSessionPersistence } from "@/Editor/monaco/EditorModel";
import { useAgentStore } from "@/Agent/agentStore";
import AgentLayout from "@/Agent/agent-layout";
import RightPanelDock from "@/RightPanel/RightPanelDock";
import RightPanelRail from "@/RightPanel/RightPanelRail";
import { useRightPanelStore } from "@/RightPanel/rightPanelStore";
import GitPage from "@/Git/GitPage";

const panels: Record<Exclude<RailView, null>, React.JSX.Element> = {
  explorer: <ExplorerPanel />,
  search: <SearchPanel />,
  git: <GitPanel />,
  menu: <MenuPanel />
};

/** Thin draggable strip for resizing the left panel. */
function SidebarResizer(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef(0);
  const dragging = useRef(false);
  const [draggingState, setDraggingState] = useState(false);

  const handlePointerDown = (event: React.PointerEvent): void => {
    event.preventDefault();
    start.current = event.clientX;
    dragging.current = true;
    setDraggingState(true);
    ref.current?.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent): void => {
    if (!dragging.current) return;
    const state = useEditorStore.getState();
    state.setPanelWidth(state.panelWidth + event.clientX - start.current);
    start.current = event.clientX;
  };

  const handlePointerUp = (event: React.PointerEvent): void => {
    if (!dragging.current) return;
    dragging.current = false;
    setDraggingState(false);
    if (ref.current?.hasPointerCapture(event.pointerId)) {
      ref.current.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={ref}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={
        draggingState
          ? "z-20 w-[5px] shrink-0 cursor-col-resize touch-none bg-primary"
          : "z-20 w-[5px] shrink-0 cursor-col-resize touch-none bg-transparent transition-colors duration-150 hover:bg-primary/40"
      }
    />
  );
}

export default function EditorLayout(): React.JSX.Element {
  const [gitPage, setGitPage] = useState(false);
  const railView = useEditorStore((state) => state.railView);
  const panelWidth = useEditorStore((state) => state.panelWidth);
  const workspacePath = useFileSystemStore((state) => state.workspace?.path);
  const agentOpen = useAgentStore((state) => state.open);
  const browserSiteId = useBrowserStore((state) => state.activeSiteId);
  const setRightPanelOpen = useRightPanelStore((state) => state.setOpen);
  const setRightPanelView = useRightPanelStore((state) => state.setView);

  useEffect(() => {
    if (browserSiteId) {
      setRightPanelView("browser");
      setRightPanelOpen(true);
    }
  }, [browserSiteId, setRightPanelOpen, setRightPanelView]);

  // Restore the previous session (groups, split layout, cursor/scroll
  // positions, dirty buffers, panel state) whenever a workspace opens.
  useEffect(() => {
    if (!workspacePath) return;
    void useEditorStore.getState().restoreSession(workspacePath);
  }, [workspacePath]);

  // Workspace teardown: release all Monaco models + pending session writes.
  useEffect(
    () => () => {
      useEditorStore.getState().resetProject();
      flushSessionPersistence();
      purgeAllModels();
    },
    []
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <EditorTopBar gitPage={gitPage} onToggleGit={() => setGitPage((open) => !open)} />

      <div className={gitPage ? "hidden" : "flex min-h-0 flex-1 overflow-hidden"}>
      {agentOpen ? (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden"><AgentLayout /></div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ActivityRail />

          <AnimatePresence initial={false}>
            {railView && (
              <motion.div
                key={railView}
                initial={false}
                animate={{ width: panelWidth, x: 0, opacity: 1 }}
                exit={{ width: 0, opacity: 0, x: -16 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="shrink-0 overflow-hidden"
              >
                {panels[railView]}
              </motion.div>
            )}
          </AnimatePresence>

          {railView && <SidebarResizer />}

          <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-editor-chrome">
            <EditorGrid />
            <BottomTerminal />
          </main>

          <RightPanelDock />
          <RightPanelRail />
        </div>
      )}
      </div>

      {gitPage && <GitPage />}

      {!agentOpen && !gitPage && <EditorStatusBar />}
    </div>
  );
}
