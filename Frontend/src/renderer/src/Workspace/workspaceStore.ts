import { create } from "zustand";
import { useEditorStore } from "@/Editor/editorStore";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import { useRecentStore } from "@/Workspace/recentStore";

export type WorkspaceTab = "overview" | "marketplace" | "projects" | "history";

interface WorkspaceState {
  activeTab: WorkspaceTab;
  setTab: (tab: WorkspaceTab) => void;
  editorOpen: boolean;
  editorWasOpened: boolean;
  openEditor: () => Promise<void>;
  openProject: () => Promise<void>;
  openRecentProject: (path: string, name: string) => Promise<void>;
  openNewProject: () => Promise<void>;
  closeEditor: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeTab: "overview",
  setTab: (tab) => set({ activeTab: tab }),
  editorOpen: false,
  editorWasOpened: false,
  openEditor: async () => {
    const fs = useFileSystemStore.getState();
    if (!fs.workspace) {
      const opened = await fs.openWorkspace();
      if (!opened) return;
    }
    const workspace = useFileSystemStore.getState().workspace;
    if (workspace) {
      useRecentStore.getState().addRecentProject({ path: workspace.path, name: workspace.name });
    }
    set({ editorOpen: true, editorWasOpened: true });
  },
  openProject: async () => {
    const fs = useFileSystemStore.getState();
    const opened = await fs.openWorkspace();
    if (!opened) return;
    const workspace = useFileSystemStore.getState().workspace;
    useEditorStore.getState().resetProject();
    if (workspace) {
      useRecentStore.getState().addRecentProject({ path: workspace.path, name: workspace.name });
    }
    set({ editorOpen: true, editorWasOpened: true });
  },
  openRecentProject: async (path, name) => {
    const fs = useFileSystemStore.getState();
    const opened = await fs.openWorkspaceByPath(path, name);
    if (!opened) return;
    useEditorStore.getState().resetProject();
    useRecentStore.getState().addRecentProject({ path, name });
    set({ editorOpen: true, editorWasOpened: true });
  },
  openNewProject: async () => {
    const fs = useFileSystemStore.getState();
    const opened = await fs.openWorkspace();
    if (!opened) return;
    const workspace = useFileSystemStore.getState().workspace;
    useEditorStore.getState().resetProject();
    if (workspace) {
      useRecentStore.getState().addRecentProject({ path: workspace.path, name: workspace.name });
    }
    set({ editorOpen: true, editorWasOpened: true });
  },
  closeEditor: () => set({ editorOpen: false })
}));
