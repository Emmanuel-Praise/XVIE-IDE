import { create } from "zustand";
import { resolveLanguage } from "@/Editor/monaco/LanguageRegistry";
import {
  allViewStates,
  loadSession,
  persistSession,
  releaseModel,
  renameModel,
  seedViewStates
} from "@/Editor/monaco/EditorModel";
import {
  createEmptyGroup,
  createGroupId,
  getGroupIds,
  insertNewGroupAt,
  removeGroupFromTree,
  splitGroupAt,
  updateSplitSizes,
  type EditorGroup,
  type LayoutNode,
  type SplitDirection,
  type SplitSide
} from "@/Editor/editorGrid";
import type { SessionSnapshot } from "@/Editor/monaco/EditorModel";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import { useRecentStore } from "@/Workspace/recentStore";
import { useTerminalStore } from "@/Terminal/terminalStore";
import {
  isTerminalTab,
  terminalIdOfTab,
  terminalTabOf
} from "@/Terminal/terminalTab";

export type { EditorGroup, LayoutNode, SplitDirection, SplitSide } from "@/Editor/editorGrid";

export type RailView = "explorer" | "search" | "git" | "menu" | null;

export type BottomTab = "problems" | "output" | "terminal" | "debug";

export type MarkdownViewMode = "source" | "preview" | "split";

export type CsvViewMode = "grid" | "source";

export interface OpenFileState {
  name: string;
  content: string;
  binary: boolean;
  size?: number;
  isSymlink?: boolean;
  languageId: string;
  dirty: boolean;
  loading: boolean;
  error?: string;
}

interface EditorState {
  railView: RailView;
  setRailView: (view: RailView) => void;
  groups: Record<string, EditorGroup>;
  layout: LayoutNode;
  activeGroupId: string;
  panelWidth: number;
  files: Record<string, OpenFileState>;
  openFile: (path: string, groupId?: string) => Promise<void>;
  openTerminalTab: (terminalId: string, groupId?: string) => void;
  splitWithTerminal: (
    terminalId: string,
    refGroupId: string,
    side: SplitSide,
    fromGroupId?: string
  ) => void;
  dockTerminalToPanel: (terminalId: string) => void;
  closeTerminalTabsForSession: (terminalId: string) => void;
  closeTab: (path: string, groupId?: string) => void;
  closeTabEverywhere: (path: string) => void;
  setActiveFile: (path: string, groupId?: string) => void;
  setGroupActiveFile: (groupId: string, path: string) => void;
  setActiveGroup: (groupId: string) => void;
  setGroupMarkdownViewMode: (groupId: string, mode: MarkdownViewMode) => void;
  setGroupCsvViewMode: (groupId: string, mode: CsvViewMode) => void;
  splitEditor: (direction: SplitDirection) => void;
  splitEditorAt: (groupId: string, direction: SplitDirection) => void;
  splitWithFile: (path: string, refGroupId: string, side: SplitSide, fromGroupId?: string) => void;
  closeEditorGroup: (groupId: string) => void;
  moveTabToGroup: (path: string, fromGroupId: string, toGroupId: string) => void;
  resizeSplit: (splitId: string, sizes: number[]) => void;
  setPanelWidth: (width: number) => void;
  setFileContent: (path: string, content: string) => void;
  setSavedFileContent: (path: string, content: string) => void;
  autosave: (path: string) => Promise<void>;
  saveNow: (path: string) => void;
  restoreSession: (workspacePath: string) => Promise<void>;
  renameFile: (from: string, to: string) => Promise<boolean>;
  bottomTab: BottomTab;
  setBottomTab: (tab: BottomTab) => void;
  bottomOpen: boolean;
  setBottomOpen: (open: boolean) => void;
  terminalLines: string[];
  clearTerminal: () => void;
  appendTerminal: (line: string) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  resetProject: () => void;
}

const AUTOSAVE_DELAY_MS = 600;
const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEFAULT_PANEL_WIDTH = 288;
const MIN_PANEL_WIDTH = 200;
const MAX_PANEL_WIDTH = 480;

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function dirtyBuffersOf(files: Record<string, OpenFileState>): Record<string, string> {
  const dirty: Record<string, string> = {};
  for (const [path, file] of Object.entries(files)) {
    if (file.dirty) dirty[path] = file.content;
  }
  return dirty;
}

function makeDefaultGroup(): EditorGroup {
  return createEmptyGroup(createGroupId());
}

const initialGroup = makeDefaultGroup();

/** Removes empty, non-sole groups from the tree/groups map. */
function pruneEmptyGroups(state: {
  groups: Record<string, EditorGroup>;
  layout: LayoutNode;
  activeGroupId: string;
}): { groups: Record<string, EditorGroup>; layout: LayoutNode; activeGroupId: string } {
  const ids = getGroupIds(state.layout);
  if (ids.length <= 1) return state;
  let layout = state.layout;
  let changed = false;
  const groups: Record<string, EditorGroup> = { ...state.groups };
  for (const id of ids) {
    const group = groups[id];
    if (!group || group.tabs.length > 0) continue;
    if (Object.keys(groups).length <= 1) continue;
    const result = removeGroupFromTree(layout, id);
    if (result.removed && result.node) {
      changed = true;
      layout = result.node;
      delete groups[id];
    }
  }
  if (!changed) return state;
  const remaining = getGroupIds(layout);
  const activeGroupId = remaining.includes(state.activeGroupId)
    ? state.activeGroupId
    : (remaining[0] ?? state.activeGroupId);
  return { groups, layout, activeGroupId };
}

/** True when every group node in the tree references an existing group. */
function layoutReferencesValid(tree: LayoutNode, valid: Set<string>): boolean {
  if (tree.type === "group") return valid.has(tree.id);
  return tree.children.every((child) => layoutReferencesValid(child, valid));
}

/**
 * Persists the current session (groups, split layout, view states, dirty
 * buffers, editor UI state) for the open workspace. Debounced internally; safe
 * to call on every change.
 */
export function persistEditorSession(): void {
  const state = useEditorStore.getState();
  const workspace = useFileSystemStore.getState().workspace;
  if (!workspace) return;
  const snapshot: SessionSnapshot = {
    version: 2,
    // Terminal tabs reference live shells that don't survive reload.
    groups: Object.values(state.groups).map((group) => {
      const tabs = group.tabs.filter((tab) => !isTerminalTab(tab));
      return {
        id: group.id,
        tabs,
        activeFile: isTerminalTab(group.activeFile)
          ? (tabs[tabs.length - 1] ?? "")
          : group.activeFile,
        markdownViewMode: group.markdownViewMode,
        csvViewMode: group.csvViewMode
      };
    }),
    layoutTree: state.layout,
    activeGroupId: state.activeGroupId,
    panelWidth: state.panelWidth,
    viewStates: allViewStates(),
    dirtyBuffers: dirtyBuffersOf(state.files),
    ui: {
      railView: state.railView,
      bottomOpen: state.bottomOpen,
      bottomTab: state.bottomTab
    }
  };
  persistSession(workspace.path, snapshot);
}

function flushWrite(path: string): void {
  const timer = autosaveTimers.get(path);
  if (timer) {
    clearTimeout(timer);
    autosaveTimers.delete(path);
  }
  const file = useEditorStore.getState().files[path];
  if (!file || !file.dirty) return;
  void useFileSystemStore.getState().writeFile(path, file.content).then((result) => {
    if (!result.success) return;
    useEditorStore.setState((state) => {
      const current = state.files[path];
      if (!current) return state;
      return { files: { ...state.files, [path]: { ...current, dirty: false } } };
    });
  });
}

export const useEditorStore = create<EditorState>((set, get) => ({
  railView: "explorer",
  setRailView: (view) =>
    set((state) => ({ railView: state.railView === view ? null : view })),
  groups: { [initialGroup.id]: initialGroup },
  layout: { type: "group", id: initialGroup.id },
  activeGroupId: initialGroup.id,
  panelWidth: DEFAULT_PANEL_WIDTH,
  files: {},

  openTerminalTab: (terminalId, groupId) => {
    const state = get();
    const gid = groupId ?? state.activeGroupId;
    if (!state.groups[gid]) return;
    if (!useTerminalStore.getState().terminals.some((t) => t.id === terminalId)) return;
    const tab = terminalTabOf(terminalId);
    const groups: Record<string, EditorGroup> = {};
    for (const [id, group] of Object.entries(state.groups)) {
      if (id === gid) continue;
      // One presence per terminal: pull it out of every other group.
      if (!group.tabs.includes(tab)) {
        groups[id] = group;
        continue;
      }
      const tabs = group.tabs.filter((t) => t !== tab);
      groups[id] = {
        ...group,
        tabs,
        activeFile: group.activeFile === tab ? (tabs[tabs.length - 1] ?? "") : group.activeFile
      };
    }
    const target = state.groups[gid];
    groups[gid] = {
      ...target,
      tabs: target.tabs.includes(tab) ? target.tabs : [...target.tabs, tab],
      activeFile: tab
    };
    const cleaned = pruneEmptyGroups({ groups, layout: state.layout, activeGroupId: gid });
    set({
      groups: cleaned.groups,
      layout: cleaned.layout,
      activeGroupId: cleaned.activeGroupId
    });
    useTerminalStore.getState().moveTerminal(terminalId, "editor");
    persistEditorSession();
  },

  splitWithTerminal: (terminalId, refGroupId, side, fromGroupId) => {
    const state = get();
    if (!state.groups[refGroupId]) return;
    if (!useTerminalStore.getState().terminals.some((t) => t.id === terminalId)) return;
    const tab = terminalTabOf(terminalId);

    const group = createEmptyGroup(createGroupId());
    group.tabs = [tab];
    group.activeFile = tab;

    const layout = insertNewGroupAt(state.layout, refGroupId, side, group.id);
    const groups: Record<string, EditorGroup> = { ...state.groups, [group.id]: group };

    for (const id of Object.keys(groups)) {
      if (id === group.id) continue;
      if (fromGroupId && id !== fromGroupId) continue;
      const source = groups[id];
      if (!source.tabs.includes(tab)) continue;
      const tabs = source.tabs.filter((t) => t !== tab);
      groups[id] = {
        ...source,
        tabs,
        activeFile: source.activeFile === tab ? (tabs[tabs.length - 1] ?? "") : source.activeFile
      };
    }

    const cleaned = pruneEmptyGroups({ groups, layout, activeGroupId: group.id });
    set({
      groups: cleaned.groups,
      layout: cleaned.layout,
      activeGroupId: cleaned.activeGroupId
    });
    useTerminalStore.getState().moveTerminal(terminalId, "editor");
    persistEditorSession();
  },

  dockTerminalToPanel: (terminalId) => {
    const state = get();
    const tab = terminalTabOf(terminalId);
    let changed = false;
    const groups: Record<string, EditorGroup> = {};
    for (const [id, group] of Object.entries(state.groups)) {
      if (!group.tabs.includes(tab)) {
        groups[id] = group;
        continue;
      }
      changed = true;
      const tabs = group.tabs.filter((t) => t !== tab);
      groups[id] = {
        ...group,
        tabs,
        activeFile: group.activeFile === tab ? (tabs[tabs.length - 1] ?? "") : group.activeFile
      };
    }
    if (changed) {
      const cleaned = pruneEmptyGroups({
        groups,
        layout: state.layout,
        activeGroupId: state.activeGroupId
      });
      set({
        groups: cleaned.groups,
        layout: cleaned.layout,
        activeGroupId: cleaned.activeGroupId
      });
      persistEditorSession();
    }
    useTerminalStore.getState().moveTerminal(terminalId, "panel");
  },

  closeTerminalTabsForSession: (terminalId) => {
    const tab = terminalTabOf(terminalId);
    const state = get();
    if (!Object.values(state.groups).some((group) => group.tabs.includes(tab))) return;
    const groups: Record<string, EditorGroup> = {};
    for (const [id, group] of Object.entries(state.groups)) {
      if (!group.tabs.includes(tab)) {
        groups[id] = group;
        continue;
      }
      const tabs = group.tabs.filter((t) => t !== tab);
      groups[id] = {
        ...group,
        tabs,
        activeFile: group.activeFile === tab ? (tabs[tabs.length - 1] ?? "") : group.activeFile
      };
    }
    const cleaned = pruneEmptyGroups({
      groups,
      layout: state.layout,
      activeGroupId: state.activeGroupId
    });
    set({
      groups: cleaned.groups,
      layout: cleaned.layout,
      activeGroupId: cleaned.activeGroupId
    });
    persistEditorSession();
  },

  openFile: async (path, groupId) => {
    if (isTerminalTab(path)) {
      get().openTerminalTab(terminalIdOfTab(path), groupId);
      return;
    }
    const gid = groupId ?? get().activeGroupId;
    if (!get().groups[gid]) return;
    const cached = get().files[path];

    set((state) => {
      const group = state.groups[gid];
      if (!group) return state;
      return {
        groups: {
          ...state.groups,
          [gid]: {
            ...group,
            tabs: group.tabs.includes(path) ? group.tabs : [...group.tabs, path],
            activeFile: path
          }
        },
        activeGroupId: gid,
        files: cached
          ? state.files
          : {
              ...state.files,
              [path]: {
                name: fileNameOf(path),
                content: "",
                binary: false,
                languageId: "plaintext",
                dirty: false,
                loading: true
              }
            }
      };
    });

    if (cached && !cached.loading && cached.content !== "") return;

    const fs = useFileSystemStore.getState();
    let result: Awaited<ReturnType<typeof fs.readFile>>;
    try {
      result = await fs.readFile(path);
    } catch {
      result = null;
    }
    const name = fileNameOf(path);
    if (!result) {
      set((state) => ({
        files: {
          ...state.files,
          [path]: { ...state.files[path], loading: false, error: "Unable to read file." }
        }
      }));
      return;
    }
    if (result.binary) {
      set((state) => ({
        files: {
          ...state.files,
          [path]: {
            name,
            content: "",
            binary: true,
            size: result.size,
            isSymlink: result.isSymlink,
            languageId: "plaintext",
            dirty: false,
            loading: false
          }
        }
      }));
      return;
    }
    const language = resolveLanguage({ name, path }, result.content);
    set((state) => ({
      files: {
        ...state.files,
        [path]: {
          name,
          content: result.content,
          binary: false,
          isSymlink: result.isSymlink,
          languageId: language.id,
          dirty: false,
          loading: false
        }
      }
    }));

    const workspace = useFileSystemStore.getState().workspace;
    if (workspace) {
      useRecentStore.getState().addRecentFile({
        path,
        name,
        workspacePath: workspace.path
      });
    }
  },

  closeTab: (path, groupId) => {
    // Closing a terminal tab kills its shell (VS Code behavior).
    if (isTerminalTab(path)) {
      const state = get();
      const gid = groupId ?? state.activeGroupId;
      const group = state.groups[gid];
      if (!group) return;
      const tabs = group.tabs.filter((tab) => tab !== path);
      const activeFile =
        group.activeFile === path ? (tabs[tabs.length - 1] ?? "") : group.activeFile;
      const groups: Record<string, EditorGroup> = {
        ...state.groups,
        [gid]: { ...group, tabs, activeFile }
      };
      const stillOpenElsewhere = Object.keys(groups).some(
        (id) => id !== gid && groups[id].tabs.includes(path)
      );
      const cleaned = pruneEmptyGroups({
        groups,
        layout: state.layout,
        activeGroupId: state.activeGroupId
      });
      set({
        groups: cleaned.groups,
        layout: cleaned.layout,
        activeGroupId: cleaned.activeGroupId
      });
      if (!stillOpenElsewhere) {
        useTerminalStore.getState().closeTerminal(terminalIdOfTab(path));
      }
      persistEditorSession();
      return;
    }
    const state = get();
    const gid = groupId ?? state.activeGroupId;
    const group = state.groups[gid];
    if (!group) return;

    const tabs = group.tabs.filter((tab) => tab !== path);
    const activeFile =
      group.activeFile === path ? (tabs[tabs.length - 1] ?? "") : group.activeFile;
    const groups: Record<string, EditorGroup> = {
      ...state.groups,
      [gid]: { ...group, tabs, activeFile }
    };

    const stillOpenElsewhere = Object.keys(groups).some(
      (id) => id !== gid && groups[id].tabs.includes(path)
    );
    const files = { ...state.files };
    if (!stillOpenElsewhere) {
      releaseModel(path);
      delete files[path];
    }

    const cleaned = pruneEmptyGroups({
      groups,
      layout: state.layout,
      activeGroupId: state.activeGroupId
    });
    set({
      groups: cleaned.groups,
      layout: cleaned.layout,
      activeGroupId: cleaned.activeGroupId,
      files
    });
    persistEditorSession();
  },

  closeTabEverywhere: (path) => {
    if (isTerminalTab(path)) {
      const state = get();
      const groups: Record<string, EditorGroup> = {};
      for (const [id, group] of Object.entries(state.groups)) {
        const tabs = group.tabs.filter((tab) => tab !== path);
        const activeFile =
          group.activeFile === path ? (tabs[tabs.length - 1] ?? "") : group.activeFile;
        groups[id] = { ...group, tabs, activeFile };
      }
      const cleaned = pruneEmptyGroups({
        groups,
        layout: state.layout,
        activeGroupId: state.activeGroupId
      });
      set({
        groups: cleaned.groups,
        layout: cleaned.layout,
        activeGroupId: cleaned.activeGroupId
      });
      useTerminalStore.getState().closeTerminal(terminalIdOfTab(path));
      persistEditorSession();
      return;
    }
    const state = get();
    const groups: Record<string, EditorGroup> = {};
    for (const [id, group] of Object.entries(state.groups)) {
      const tabs = group.tabs.filter((tab) => tab !== path);
      const activeFile =
        group.activeFile === path ? (tabs[tabs.length - 1] ?? "") : group.activeFile;
      groups[id] = { ...group, tabs, activeFile };
    }
    releaseModel(path);
    const files = { ...state.files };
    delete files[path];
    const cleaned = pruneEmptyGroups({
      groups,
      layout: state.layout,
      activeGroupId: state.activeGroupId
    });
    set({
      groups: cleaned.groups,
      layout: cleaned.layout,
      activeGroupId: cleaned.activeGroupId,
      files
    });
    persistEditorSession();
  },

  setGroupActiveFile: (groupId, path) => {
    const group = get().groups[groupId];
    if (!group) return;
    set((state) => ({
      groups: { ...state.groups, [groupId]: { ...state.groups[groupId], activeFile: path } },
      activeGroupId: groupId
    }));
    if (path && !isTerminalTab(path) && !get().files[path]) {
      void get().openFile(path, groupId);
    }
  },

  setActiveFile: (path, groupId) => {
    get().setGroupActiveFile(groupId ?? get().activeGroupId, path);
  },

  setActiveGroup: (groupId) => {
    if (!get().groups[groupId] || get().activeGroupId === groupId) return;
    set({ activeGroupId: groupId });
  },

  setGroupMarkdownViewMode: (groupId, mode) => {
    const group = get().groups[groupId];
    if (!group) return;
    set((state) => ({
      groups: { ...state.groups, [groupId]: { ...state.groups[groupId], markdownViewMode: mode } }
    }));
    persistEditorSession();
  },

  setGroupCsvViewMode: (groupId, mode) => {
    const group = get().groups[groupId];
    if (!group) return;
    set((state) => ({
      groups: { ...state.groups, [groupId]: { ...state.groups[groupId], csvViewMode: mode } }
    }));
    persistEditorSession();
  },

  splitEditor: (direction) => {
    get().splitEditorAt(get().activeGroupId, direction);
  },

  /**
   * Splits a group by moving the CURRENT active file into a new group on the
   * given side. The rest of the tab bar stays put (no duplication); the source
   * group keeps any remaining tabs and survives even if it ends up empty, so
   * repeated splits keep adding panes.
   */
  splitEditorAt: (groupId, direction) => {
    const state = get();
    const source = state.groups[groupId];
    if (!source || !source.activeFile) return;
    const activeFile = source.activeFile;
    const sourceTabs = source.tabs.filter((tab) => tab !== activeFile);
    const next = createEmptyGroup(createGroupId());
    next.tabs = [activeFile];
    next.activeFile = activeFile;
    next.markdownViewMode = source.markdownViewMode;
    next.csvViewMode = source.csvViewMode;
    set({
      groups: {
        ...state.groups,
        [groupId]: {
          ...source,
          tabs: sourceTabs,
          activeFile: sourceTabs[sourceTabs.length - 1] ?? ""
        },
        [next.id]: next
      },
      layout: splitGroupAt(state.layout, groupId, direction, next.id),
      activeGroupId: next.id
    });
    persistEditorSession();
  },

  splitWithFile: (path, refGroupId, side, fromGroupId) => {
    const state = get();
    if (!state.groups[refGroupId]) return;

    const group = createEmptyGroup(createGroupId());
    group.tabs = [path];
    group.activeFile = path;

    const layout = insertNewGroupAt(state.layout, refGroupId, side, group.id);
    let groups: Record<string, EditorGroup> = { ...state.groups, [group.id]: group };

    if (fromGroupId && fromGroupId !== group.id && groups[fromGroupId]) {
      const source = groups[fromGroupId];
      const tabs = source.tabs.filter((tab) => tab !== path);
      const activeFile =
        source.activeFile === path ? (tabs[tabs.length - 1] ?? "") : source.activeFile;
      groups[fromGroupId] = { ...source, tabs, activeFile };
    }

    const cleaned = pruneEmptyGroups({ groups, layout, activeGroupId: group.id });
    set({
      groups: cleaned.groups,
      layout: cleaned.layout,
      activeGroupId: cleaned.activeGroupId
    });

    if (!isTerminalTab(path)) {
      const file = get().files[path];
      if (!file || file.loading) {
        void get().openFile(path, group.id);
      }
    }
    persistEditorSession();
  },

  closeEditorGroup: (groupId) => {
    const state = get();
    const group = state.groups[groupId];
    if (!group) return;

    const ids = getGroupIds(state.layout);
    if (ids.length === 1) {
      set((s) => {
        const current = s.groups[groupId];
        if (!current) return s;
        return {
          groups: { ...s.groups, [groupId]: { ...current, tabs: [], activeFile: "" } }
        };
      });
      persistEditorSession();
      return;
    }

    const remaining = ids.filter((id) => id !== groupId);
    const targetId = remaining[0];
    const groups: Record<string, EditorGroup> = { ...state.groups };
    const target = groups[targetId];
    const targetTabs = [...target.tabs];
    for (const tab of group.tabs) {
      if (!targetTabs.includes(tab)) targetTabs.push(tab);
    }
    groups[targetId] = { ...target, tabs: targetTabs };
    delete groups[groupId];

    const result = removeGroupFromTree(state.layout, groupId);
    set({
      groups,
      layout: result.node ?? state.layout,
      activeGroupId: targetId
    });
    persistEditorSession();
  },

  moveTabToGroup: (path, fromGroupId, toGroupId) => {
    if (fromGroupId === toGroupId) return;
    const state = get();
    const source = state.groups[fromGroupId];
    const target = state.groups[toGroupId];
    if (!source || !target) return;

    const groups: Record<string, EditorGroup> = { ...state.groups };
    groups[toGroupId] = {
      ...target,
      tabs: target.tabs.includes(path) ? target.tabs : [...target.tabs, path],
      activeFile: path
    };
    const sourceTabs = source.tabs.filter((tab) => tab !== path);
    groups[fromGroupId] = {
      ...source,
      tabs: sourceTabs,
      activeFile:
        source.activeFile === path ? (sourceTabs[sourceTabs.length - 1] ?? "") : source.activeFile
    };

    const cleaned = pruneEmptyGroups({ groups, layout: state.layout, activeGroupId: toGroupId });
    set({
      groups: cleaned.groups,
      layout: cleaned.layout,
      activeGroupId: cleaned.activeGroupId
    });
    persistEditorSession();
  },

  resizeSplit: (splitId, sizes) => {
    set((state) => ({ layout: updateSplitSizes(state.layout, splitId, sizes) }));
    persistEditorSession();
  },

  setPanelWidth: (width) => {
    const clamped = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(width)));
    if (clamped === get().panelWidth) return;
    set({ panelWidth: clamped });
    persistEditorSession();
  },

  setFileContent: (path, content) => {
    const file = get().files[path];
    if (!file || file.content === content) return;
    set((state) => ({
      files: { ...state.files, [path]: { ...file, content, dirty: true } }
    }));
    persistEditorSession();
  },

  // A workspace operation already wrote this exact content to disk. Update
  // the editor buffer without scheduling a second, asynchronous write that
  // could race a later Browser Agent append.
  setSavedFileContent: (path, content) => {
    const timer = autosaveTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      autosaveTimers.delete(path);
    }
    const file = get().files[path];
    if (!file || (file.content === content && !file.dirty)) return;
    set((state) => ({
      files: { ...state.files, [path]: { ...file, content, dirty: false } }
    }));
    persistEditorSession();
  },

  autosave: async (path) => {
    const existing = autosaveTimers.get(path);
    if (existing) clearTimeout(existing);
    autosaveTimers.set(path, setTimeout(() => flushWrite(path), AUTOSAVE_DELAY_MS));
  },

  saveNow: (path) => {
    flushWrite(path);
  },

  restoreSession: async (workspacePath) => {
    const snapshot = loadSession(workspacePath);
    if (!snapshot) return;
    seedViewStates(snapshot.viewStates);

    const seedFiles: Record<string, OpenFileState> = {};
    for (const [path, content] of Object.entries(snapshot.dirtyBuffers)) {
      const name = fileNameOf(path);
      const language = resolveLanguage({ name, path }, content);
      seedFiles[path] = {
        name,
        content,
        binary: false,
        languageId: language.id,
        dirty: true,
        loading: false
      };
    }

    const groups: Record<string, EditorGroup> = {};
    for (const info of snapshot.groups) {
      // Drop stale terminal tabs (live shells are never persisted).
      const tabs = info.tabs.filter((tab) => !isTerminalTab(tab));
      groups[info.id] = {
        id: info.id,
        tabs,
        activeFile: isTerminalTab(info.activeFile)
          ? (tabs[tabs.length - 1] ?? "")
          : info.activeFile,
        markdownViewMode: info.markdownViewMode,
        csvViewMode: info.csvViewMode ?? "grid"
      };
    }

    const validIds = new Set(Object.keys(groups));
    let layout = snapshot.layoutTree;
    if (!layoutReferencesValid(layout, validIds)) {
      const id = Object.keys(groups)[0] ?? createGroupId();
      layout = { type: "group", id };
      if (!groups[id]) groups[id] = createEmptyGroup(id);
    }
    const treeIds = getGroupIds(layout);
    const activeGroupId = groups[snapshot.activeGroupId]
      ? snapshot.activeGroupId
      : (treeIds[0] ?? Object.keys(groups)[0] ?? "");

    set((state) => ({
      files: { ...state.files, ...seedFiles },
      groups,
      layout,
      activeGroupId,
      railView: (snapshot.ui?.railView as string | undefined) === "browser"
        ? state.railView
        : snapshot.ui?.railView ?? state.railView,
      bottomOpen: snapshot.ui?.bottomOpen ?? state.bottomOpen,
      bottomTab: snapshot.ui?.bottomTab ?? state.bottomTab,
      panelWidth: snapshot.panelWidth ?? state.panelWidth
    }));

    for (const group of Object.values(groups)) {
      for (const path of group.tabs) {
        const existing = get().files[path];
        if (existing && existing.content !== "" && !existing.loading) continue;
        await get().openFile(path, group.id);
      }
    }

    set((state) => {
      const fixed: Record<string, EditorGroup> = {};
      for (const [id, group] of Object.entries(state.groups)) {
        const tabs = group.tabs;
        const activeFile =
          group.activeFile && tabs.includes(group.activeFile)
            ? group.activeFile
            : (tabs[tabs.length - 1] ?? "");
        fixed[id] = { ...group, activeFile };
      }
      return { groups: fixed, activeGroupId };
    });

    persistEditorSession();
  },

  renameFile: async (from, to) => {
    const fsResult = await useFileSystemStore.getState().rename(from, to);
    if (!fsResult.success) return false;
    const remap = (path: string): string =>
      path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
    set((state) => {
      const files: Record<string, OpenFileState> = {};
      for (const [key, value] of Object.entries(state.files)) {
        files[remap(key)] = value;
      }
      const groups: Record<string, EditorGroup> = {};
      for (const [id, group] of Object.entries(state.groups)) {
        groups[id] = {
          ...group,
          tabs: group.tabs.map(remap),
          activeFile: remap(group.activeFile)
        };
      }
      return { files, groups };
    });
    renameModel(from, to);
    persistEditorSession();
    return true;
  },

  bottomTab: "terminal",
  setBottomTab: (tab) => set({ bottomTab: tab }),
  bottomOpen: true,
  setBottomOpen: (open) => set({ bottomOpen: open }),
  terminalLines: [],
  clearTerminal: () => set({ terminalLines: [] }),
  appendTerminal: (line) =>
    set((state) => ({ terminalLines: [...state.terminalLines, line] })),
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  searchQuery: "",
  setSearchQuery: (query) => set({ searchQuery: query }),
  resetProject: () => {
    const group = makeDefaultGroup();
    set({
      railView: "explorer",
      groups: { [group.id]: group },
      layout: { type: "group", id: group.id },
      activeGroupId: group.id,
      panelWidth: DEFAULT_PANEL_WIDTH,
      files: {},
      bottomTab: "terminal",
      bottomOpen: true,
      terminalLines: [],
      settingsOpen: false,
      searchQuery: ""
    });
  }
}));
