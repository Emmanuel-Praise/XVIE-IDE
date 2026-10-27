import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Code2 } from "lucide-react";
import TopBar from "@/Workspace/components/topbar";
import Sidebar from "@/Workspace/components/sidebar";
import MobileNav from "@/Workspace/components/mobile-nav";
import OverviewPage from "@/Workspace/Overview/OverviewPage";
import MarketplacePage from "@/Workspace/Marketplace/MarketplacePage";
import ProjectsPage from "@/Workspace/Projects/ProjectsPage";
import HistoryPage from "@/Workspace/History/HistoryPage";
import EditorLayout from "@/Editor/editor-layout";
import { useWorkspaceStore } from "@/Workspace/workspaceStore";

export default function WorkspaceLayout(): React.JSX.Element {
  const activeTab = useWorkspaceStore((state) => state.activeTab);
  const editorOpen = useWorkspaceStore((state) => state.editorOpen);
  const editorWasOpened = useWorkspaceStore((state) => state.editorWasOpened);
  const openEditor = useWorkspaceStore((state) => state.openEditor);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const pages: Record<string, React.JSX.Element> = {
    overview: <OverviewPage key="overview" />,
    marketplace: <MarketplacePage key="marketplace" />,
    projects: <ProjectsPage key="projects" />,
    history: <HistoryPage key="history" />
  };

  if (editorOpen) {
    return <EditorLayout />;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="hidden shrink-0 md:block">
        <Sidebar />
      </div>
      <MobileNav open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar onOpenMobileNav={() => setMobileNavOpen(true)} />

        <main className="flex flex-1 flex-col overflow-y-auto bg-background">
          <div className="flex w-full flex-1 flex-col px-margin-mobile py-lg md:px-margin-desktop md:py-xl">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="flex flex-1 flex-col"
              >
                {pages[activeTab]}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>

      {editorWasOpened && !editorOpen && (
        <button
          type="button"
          onClick={openEditor}
          className="fixed bottom-6 right-6 z-50 flex cursor-pointer items-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-label-md text-label-md font-medium text-on-primary shadow-[0_4px_16px_rgba(0,0,0,0.2)] transition-all duration-200 hover:shadow-[0_8px_24px_rgba(0,0,0,0.3)] hover:brightness-110 active:scale-[0.97]"
        >
          <Code2 size={15} strokeWidth={2} />
          Back to Editor
        </button>
      )}
    </div>
  );
}
