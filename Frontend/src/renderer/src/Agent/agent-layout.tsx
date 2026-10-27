import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useAgentStore } from "./agentStore";
import AgentViewHeader from "./components/header/agent-view-header";
import ConversationWorkspace from "./components/conversation/conversation-workspace";
import AgentWelcome from "./components/welcome/agent-welcome";
import PromptArea from "./components/prompt/prompt-area";
import AgentSidebar from "./components/sidebar/agent-sidebar";
import ProviderSettings from "./components/settings/provider-settings";
import NotificationToasts from "./components/notifications/notification-toasts";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import "./styles/agent-markdown.css";

export default function AgentLayout() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const session = useAgentStore((s) => s.activeSession());
  const sidebarOpen = useAgentStore((s) => s.sidebarOpen);
  const workspacePath = useFileSystemStore((s) => s.workspace?.path);
  const loadSessions = useAgentStore((s) => s.loadSessions);
  const setWorkspaceScope = useAgentStore((s) => s.setWorkspaceScope);
  const refreshProviders = useAgentStore((s) => s.refreshProviders);
  const setSidebarOpen = useAgentStore((s) => s.setSidebarOpen);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);
  useEffect(() => {
    setWorkspaceScope(workspacePath ?? null);
    if (workspacePath) void loadSessions();
  }, [workspacePath, loadSessions, setWorkspaceScope]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <AgentViewHeader onOpenSettings={() => setSettingsOpen(true)} />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Main transcript column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {session ? <ConversationWorkspace session={session} /> : <AgentWelcome />}
          </div>
          <PromptArea />
        </div>

        {/* Session panel */}
        <AnimatePresence initial={false}>{sidebarOpen && <AgentSidebar key="agent-sidebar" />}</AnimatePresence>
      </div>
      <ProviderSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <NotificationToasts />
    </div>
  );
}
