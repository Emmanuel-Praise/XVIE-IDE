import { create } from "zustand";
import type {
  FsEntry,
  FsResult,
  ReadFileResult
} from "../../../../shared/ipc-types";

interface WorkspaceInfo {
  path: string;
  name: string;
}

interface FileSystemState {
  workspace: WorkspaceInfo | null;
  opening: boolean;
  entries: Record<string, FsEntry[]>;
  expanded: Record<string, boolean>;
  loading: Record<string, boolean>;
  fileCache: Record<string, ReadFileResult>;
  binaryCache: Record<string, Uint8Array>;
  gitStatuses: Record<string, string>;
  openWorkspace: () => Promise<boolean>;
  openWorkspaceByPath: (path: string, name: string) => Promise<boolean>;
  closeWorkspace: () => void;
  expand: (path: string) => Promise<void>;
  toggle: (path: string) => Promise<void>;
  peek: (path: string) => Promise<void>;
  collapseAll: () => void;
  refresh: (path: string) => Promise<void>;
  readFile: (path: string) => Promise<ReadFileResult | null>;
  readBinary: (path: string) => Promise<Uint8Array | null>;
  invalidateBinary: (path: string) => void;
  writeFile: (path: string, content: string) => Promise<FsResult>;
  rename: (from: string, to: string) => Promise<FsResult>;
  createFile: (path: string) => Promise<FsResult>;
  createFolder: (path: string) => Promise<FsResult>;
  deleteEntry: (path: string) => Promise<FsResult>;
  handleChanged: (path: string) => void;
}

const workspaceApi = window.api?.workspace;

function isChildOf(path: string, ancestor: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const base = ancestor.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === base || normalized.startsWith(`${base}/`);
}

export const useFileSystemStore = create<FileSystemState>((set, get) => ({
  workspace: null,
  opening: false,
  entries: {},
  expanded: {},
  loading: {},
  fileCache: {},
  binaryCache: {},
  gitStatuses: {},

  openWorkspace: async () => {
    if (!workspaceApi) return false;
    set({ opening: true });
    const result = await workspaceApi.openFolder();
    if (result.canceled) {
      set({ opening: false });
      return false;
    }
    set({
      workspace: { path: result.path, name: result.name },
      opening: false,
      entries: {},
      expanded: { [result.path]: true },
      fileCache: {},
      binaryCache: {},
      gitStatuses: {}
    });
    workspaceApi.onChanged((path) => get().handleChanged(path));
    void get().expand(result.path);
    return true;
  },

  openWorkspaceByPath: async (path, name) => {
    if (!workspaceApi) return false;
    set({ opening: true });
    try {
      const result = await workspaceApi.openPath(path);
      if (!result.success) {
        set({ opening: false });
        return false;
      }
      set({
        workspace: { path, name },
        opening: false,
        entries: {},
        expanded: { [path]: true },
        fileCache: {},
        binaryCache: {},
        gitStatuses: {}
      });
      workspaceApi.onChanged((changedPath) => get().handleChanged(changedPath));
      void get().expand(path);
      return true;
    } catch {
      set({ opening: false });
      return false;
    }
  },

  closeWorkspace: () => set({ workspace: null, entries: {}, expanded: {}, fileCache: {}, binaryCache: {}, gitStatuses: {} }),

  expand: async (path) => {
    if (!workspaceApi) return;
    const { entries, expanded, loading } = get();
    if (expanded[path] && entries[path]) return;
    if (loading[path]) return;
    set({ loading: { ...loading, [path]: true } });
    try {
      const snapshot = await workspaceApi.scanDir(path);
      set((state) => ({
        entries: { ...state.entries, [path]: snapshot },
        expanded: { ...state.expanded, [path]: true },
        loading: { ...state.loading, [path]: false }
      }));
    } catch {
      set((state) => ({ loading: { ...state.loading, [path]: false } }));
    }
  },

  toggle: async (path) => {
    const { expanded, entries } = get();
    if (!expanded[path] && !entries[path]) {
      await get().expand(path);
      return;
    }
    set((state) => ({ expanded: { ...state.expanded, [path]: !state.expanded[path] } }));
  },

  /** Loads a folder's children without expanding it, so icons can reflect
   * what the folder contains while the tree stays collapsed. */
  peek: async (path) => {
    if (!workspaceApi) return;
    const { entries, loading } = get();
    if (entries[path] || loading[path]) return;
    set((state) => ({ loading: { ...state.loading, [path]: true } }));
    try {
      const snapshot = await workspaceApi.scanDir(path);
      set((state) => ({
        entries: { ...state.entries, [path]: snapshot },
        loading: { ...state.loading, [path]: false }
      }));
    } catch {
      set((state) => ({ loading: { ...state.loading, [path]: false } }));
    }
  },

  collapseAll: () => {
    const { workspace, expanded } = get();
    const collapsed = Object.fromEntries(Object.keys(expanded).map((path) => [path, false]));
    if (workspace) collapsed[workspace.path] = false;
    set({ expanded: collapsed });
  },

  refresh: async (path) => {
    if (!workspaceApi || !get().entries[path]) return;
    set((state) => ({ loading: { ...state.loading, [path]: true } }));
    try {
      const snapshot = await workspaceApi.scanDir(path);
      set((state) => ({
        entries: { ...state.entries, [path]: snapshot },
        loading: { ...state.loading, [path]: false }
      }));
    } catch {
      set((state) => ({ loading: { ...state.loading, [path]: false } }));
    }
  },

  readFile: async (path) => {
    if (!workspaceApi) return null;
    const cached = get().fileCache[path];
    if (cached) return cached;
    const result = await workspaceApi.readFile(path);
    if (result) set((state) => ({ fileCache: { ...state.fileCache, [path]: result } }));
    return result;
  },

  readBinary: async (path) => {
    if (!workspaceApi) return null;
    const cached = get().binaryCache[path];
    if (cached) return cached;
    const data = await workspaceApi.readBinary(path);
    if (data) {
      set((state) => ({ binaryCache: { ...state.binaryCache, [path]: data } }));
    }
    return data;
  },

  invalidateBinary: (path) => {
    set((state) => {
      const binaryCache = { ...state.binaryCache };
      delete binaryCache[path];
      return { binaryCache };
    });
  },

  writeFile: async (path, content) => {
    if (!workspaceApi) return { success: false, error: "Workspace bridge unavailable" };
    const result = await workspaceApi.createFile(path, content);
    if (result.success) {
      set((state) => ({
        fileCache: { ...state.fileCache, [path]: { binary: false, content, isSymlink: false } }
      }));
    }
    return result;
  },

  rename: async (from, to) => {
    const result = await workspaceApi.rename(from, to);
    if (result.success) {
      set((state) => {
        const entries = { ...state.entries };
        for (const key of Object.keys(entries)) {
          if (isChildOf(key, from)) delete entries[key];
          entries[key] = entries[key].map((entry) =>
            isChildOf(entry.path, from)
              ? { ...entry, path: to + entry.path.slice(from.length) }
              : entry
          );
        }
        const fileCache = { ...state.fileCache };
        const newCache: Record<string, ReadFileResult> = {};
        for (const [key, value] of Object.entries(fileCache)) {
          newCache[isChildOf(key, from) ? to + key.slice(from.length) : key] = value;
        }
        return {
          entries,
          fileCache: newCache,
          expanded: { ...state.expanded, [to]: state.expanded[from] }
        };
      });
    }
    return result;
  },

  createFile: async (path) => {
    const result = await workspaceApi.createFile(path);
    if (result.success) {
      const parent = path.split(/[\\/]/).slice(0, -1).join("/") || get().workspace?.path;
      if (parent) await get().refresh(parent);
    }
    return result;
  },

  createFolder: async (path) => {
    const result = await workspaceApi.createFolder(path);
    if (result.success) {
      const parent = path.split(/[\\/]/).slice(0, -1).join("/") || get().workspace?.path;
      if (parent) await get().refresh(parent);
    }
    return result;
  },

  deleteEntry: async (path) => {
    const result = await workspaceApi.deleteEntry(path);
    if (result.success) {
      get().handleChanged(path);
    }
    return result;
  },

  handleChanged: (path) => {
    const { entries, expanded, fileCache, workspace } = get();
    if (!workspace) return;
    const nextEntries = { ...entries };
    const nextExpanded = { ...expanded };
    for (const dir of Object.keys(entries)) {
      if (isChildOf(path, dir)) {
        void get().refresh(dir);
      }
      if (isChildOf(dir, path)) {
        delete nextEntries[dir];
        delete nextExpanded[dir];
      }
    }
    const newCache = { ...fileCache };
    for (const key of Object.keys(newCache)) {
      if (isChildOf(key, path)) delete newCache[key];
    }
    const newBinaryCache = { ...get().binaryCache };
    for (const key of Object.keys(newBinaryCache)) {
      if (isChildOf(key, path)) delete newBinaryCache[key];
    }
    set({ fileCache: newCache, binaryCache: newBinaryCache, entries: nextEntries, expanded: nextExpanded });
  }
}));
