import type { editor as MonacoEditor } from "monaco-editor";
import { getMonacoSync } from "./MonacoProvider";
import type { BottomTab, CsvViewMode, MarkdownViewMode, RailView } from "@/Editor/editorStore";
import type { LayoutNode } from "@/Editor/editorGrid";
import { createGroupId } from "@/Editor/editorGrid";

/*
 * Model lifecycle + per-file view state + session persistence.
 *
 * - Models are cached by Uri (same scheme @monaco-editor/react uses), so
 *   switching tabs never loses undo history. Multiple editor groups may attach
 *   to the same model (one source of truth per file).
 * - View states (cursor, scroll, folding, selections, sticky scroll) are kept
 *   per file and restored whenever a model attaches.
 * - Groups, split layout, view states, dirty buffers and editor UI state are
 *   persisted to localStorage (keyed by workspace root) and restored on the
 *   next launch.
 */

export interface SessionGroupInfo {
  id: string;
  tabs: string[];
  activeFile: string;
  markdownViewMode: MarkdownViewMode;
  csvViewMode?: CsvViewMode;
}

export interface SessionSnapshot {
  version: 2;
  groups: SessionGroupInfo[];
  layoutTree: LayoutNode;
  activeGroupId: string;
  panelWidth: number;
  viewStates: Record<string, MonacoEditor.ICodeEditorViewState | null>;
  dirtyBuffers: Record<string, string>;
  ui: { railView: RailView; bottomOpen: boolean; bottomTab: BottomTab };
}

interface SessionSnapshotV1 {
  version: 1;
  openTabs: string[];
  activeFile: string;
  viewStates: Record<string, MonacoEditor.ICodeEditorViewState | null>;
  dirtyBuffers: Record<string, string>;
  layout: { railView: RailView; bottomOpen: boolean; bottomTab: BottomTab };
}

const SESSION_VERSION = 2;
const SESSION_PREFIX = "xvie-editor-session";
const DIRTY_BUFFER_MAX_BYTES = 512 * 1024;
const DIRTY_BUFFERS_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_MAX_BYTES = 3.5 * 1024 * 1024;

const viewStates = new Map<string, MonacoEditor.ICodeEditorViewState | null>();

function sessionKey(workspacePath: string): string {
  return `${SESSION_PREFIX}:${workspacePath.replace(/\\/g, "/")}`;
}

function uriKey(monaco: NonNullable<ReturnType<typeof getMonacoSync>>, path: string): string {
  return monaco.Uri.parse(path).toString();
}

/** Returns the cached model for a file, creating it when missing. */
export function getOrCreateModel(
  path: string,
  content: string,
  languageId: string
): MonacoEditor.ITextModel | null {
  const monaco = getMonacoSync();
  if (!monaco) return null;
  const uri = monaco.Uri.parse(path);
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    if (existing.getLanguageId() !== languageId) {
      monaco.editor.setModelLanguage(existing, languageId);
    }
    return existing;
  }
  return monaco.editor.createModel(content, languageId, uri);
}

/**
 * Disposes a model once no editor is attached to it. With split groups several
 * editors may share a model, so disposal waits until the last reference drops.
 * Never blocks; gives up after a short window if the model is still attached.
 */
function disposeWhenFree(
  model: MonacoEditor.ITextModel,
  key: string,
  attempts = 0
): void {
  if (!model.isAttachedToEditor()) {
    model.dispose();
    viewStates.delete(key);
    return;
  }
  if (attempts > 100) return;
  setTimeout(() => disposeWhenFree(model, key, attempts + 1), 8);
}

/**
 * Releases the model of a closed tab. If the model is still attached to any
 * editor (including editors in other groups), disposal is deferred until the
 * editors have swapped away.
 */
export function releaseModel(path: string): void {
  const monaco = getMonacoSync();
  if (!monaco) return;
  const uri = monaco.Uri.parse(path);
  const model = monaco.editor.getModel(uri);
  if (!model) return;
  disposeWhenFree(model, uri.toString());
}

/** Moves a model when a file is renamed (undo history is not carried over). */
export function renameModel(from: string, to: string): void {
  const monaco = getMonacoSync();
  if (!monaco) return;
  const fromUri = monaco.Uri.parse(from);
  const model = monaco.editor.getModel(fromUri);
  const fromKey = fromUri.toString();
  const toKey = monaco.Uri.parse(to).toString();
  if (viewStates.has(fromKey)) {
    viewStates.set(toKey, viewStates.get(fromKey) ?? null);
    viewStates.delete(fromKey);
  }
  if (!model) return;
  monaco.editor.createModel(model.getValue(), model.getLanguageId(), monaco.Uri.parse(to));
  disposeWhenFree(model, fromKey);
}

/**
 * Disposes every live model. Only safe once the editor itself is disposed
 * (workspace teardown), since the editor may still reference a model.
 */
export function purgeAllModels(): void {
  const monaco = getMonacoSync();
  if (!monaco) return;
  for (const model of monaco.editor.getModels()) {
    try {
      model.dispose();
    } catch {
      // model already disposed
    }
  }
  viewStates.clear();
}

/** Saves the editor view state for a file (cursor, scroll, folding, ...). */
export function saveViewState(path: string, state: MonacoEditor.ICodeEditorViewState | null): void {
  const monaco = getMonacoSync();
  if (!monaco || !state) return;
  viewStates.set(uriKey(monaco, path), state);
}

/** Restores the saved view state for the currently attached model, if any. */
export function restoreViewStateForModel(
  editor: MonacoEditor.IStandaloneCodeEditor
): void {
  const monaco = getMonacoSync();
  const model = editor.getModel();
  if (!monaco || !model) return;
  const state = viewStates.get(model.uri.toString());
  if (state) editor.restoreViewState(state);
}

export function allViewStates(): Record<string, MonacoEditor.ICodeEditorViewState | null> {
  return Object.fromEntries(viewStates);
}

export function seedViewStates(
  states: Record<string, MonacoEditor.ICodeEditorViewState | null>
): void {
  for (const [key, state] of Object.entries(states)) {
    viewStates.set(key, state ?? null);
  }
}

/** Converts a v1 (pre-split) session into the v2 group shape. */
function migrateV1(snapshot: SessionSnapshotV1): SessionSnapshot {
  const id = createGroupId();
  return {
    version: SESSION_VERSION,
    groups: [
      {
        id,
        tabs: snapshot.openTabs ?? [],
        activeFile: snapshot.activeFile ?? "",
        markdownViewMode: "source"
      }
    ],
    layoutTree: { type: "group", id },
    activeGroupId: id,
    panelWidth: 288,
    viewStates: snapshot.viewStates ?? {},
    dirtyBuffers: snapshot.dirtyBuffers ?? {},
    ui: snapshot.layout ?? { railView: "explorer", bottomOpen: true, bottomTab: "terminal" }
  };
}

function snapshotFits(raw: string): boolean {
  return raw.length * 2 <= SESSION_MAX_BYTES;
}

function trimDirtyBuffers(snapshot: SessionSnapshot): SessionSnapshot {
  const dirtyBuffers: Record<string, string> = {};
  let total = 0;
  for (const [path, content] of Object.entries(snapshot.dirtyBuffers)) {
    const bytes = content.length * 2;
    if (bytes > DIRTY_BUFFER_MAX_BYTES || total + bytes > DIRTY_BUFFERS_MAX_BYTES) continue;
    dirtyBuffers[path] = content;
    total += bytes;
  }
  return { ...snapshot, dirtyBuffers };
}

/** Replaces a missing group config with a sane single-group default. */
function sanitizeSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  if (!snapshot.groups || snapshot.groups.length === 0) return snapshot;
  const valid = new Set(snapshot.groups.map((group) => group.id));
  let layout = snapshot.layoutTree;
  if (!layoutValid(layout, valid)) {
    layout = { type: "group", id: snapshot.groups[0].id };
  }
  const activeGroupId = snapshot.activeGroupId && valid.has(snapshot.activeGroupId)
    ? snapshot.activeGroupId
    : snapshot.groups[0].id;
  return {
    ...snapshot,
    groups: snapshot.groups.map((group) => ({
      ...group,
      tabs: Array.isArray(group.tabs) ? group.tabs : [],
      activeFile: typeof group.activeFile === "string" ? group.activeFile : ""
    })),
    layoutTree: layout,
    activeGroupId,
    panelWidth:
      typeof snapshot.panelWidth === "number" && snapshot.panelWidth >= 200 && snapshot.panelWidth <= 480
        ? snapshot.panelWidth
        : 288
  };
}

function layoutValid(tree: LayoutNode, valid: Set<string>): boolean {
  if (tree.type === "group") return valid.has(tree.id);
  return tree.children.every((child) => layoutValid(child, valid));
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSnapshot: { workspacePath: string; snapshot: SessionSnapshot } | null = null;

/** Persists the session snapshot (debounced); call on every relevant change. */
export function persistSession(workspacePath: string, snapshot: SessionSnapshot): void {
  pendingSnapshot = { workspacePath, snapshot: trimDirtyBuffers(sanitizeSnapshot(snapshot)) };
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushSessionPersistence, 600);
}

/** Writes the latest pending snapshot immediately (tab close, app exit). */
export function flushSessionPersistence(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!pendingSnapshot) return;
  const { workspacePath, snapshot } = pendingSnapshot;
  pendingSnapshot = null;
  try {
    const raw = JSON.stringify({ ...snapshot, version: SESSION_VERSION });
    if (!snapshotFits(raw)) return;
    window.localStorage.setItem(sessionKey(workspacePath), raw);
  } catch {
    // storage unavailable — session restore is best-effort
  }
}

/** Loads the session snapshot for a workspace, migrating older formats. */
export function loadSession(workspacePath: string): SessionSnapshot | null {
  try {
    const raw = window.localStorage.getItem(sessionKey(workspacePath));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionSnapshot | SessionSnapshotV1;
    if (parsed.version === 1) {
      return migrateV1(parsed);
    }
    if (parsed.version === SESSION_VERSION) {
      return sanitizeSnapshot({ ...parsed, version: SESSION_VERSION });
    }
    return null;
  } catch {
    return null;
  }
}

/** Drops the persisted session for a workspace. */
export function clearSession(workspacePath: string): void {
  try {
    window.localStorage.removeItem(sessionKey(workspacePath));
  } catch {
    // ignore
  }
}