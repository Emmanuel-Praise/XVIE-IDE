import type { editor as MonacoEditor } from "monaco-editor";
import type { MonacoApi } from "./MonacoProvider";

let activeEditorGetter: () => MonacoEditor.IStandaloneCodeEditor | null = () => null;

/** Registers the getter the command layer uses to reach the active editor. */
export function setActiveEditorGetter(
  getter: () => MonacoEditor.IStandaloneCodeEditor | null
): void {
  activeEditorGetter = getter;
}

export function getActiveEditor(): MonacoEditor.IStandaloneCodeEditor | null {
  return activeEditorGetter();
}

/**
 * Runs a Monaco command against the active editor. Works for both registered
 * actions (undo, find, ...) and raw command ids.
 */
export function runEditorCommand(commandId: string, ...args: unknown[]): void {
  const editor = getActiveEditor();
  if (!editor) return;
  const action = editor.getAction(commandId);
  if (action) {
    void action.run();
    return;
  }
  editor.trigger("xvie-menu", commandId, args[0] ?? null);
}

export interface EditorCommandHooks {
  /** Invoked on Ctrl/Cmd+S — flushes the autosave debounce for the active file. */
  onSave: () => void;
}

/**
 * Attaches Xvie-level keybindings on top of Monaco's defaults. Monaco itself
 * provides Ctrl+F/H (find/replace), Ctrl+Z/Y (undo/redo), Ctrl+G (go to line),
 * F2 (rename), F12 (go to definition), Shift+F12 (references), Alt+Click
 * (multi-cursor), etc.
 */
export function attachEditorCommands(
  monaco: MonacoApi,
  editor: MonacoEditor.IStandaloneCodeEditor,
  hooks: EditorCommandHooks
): void {
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => hooks.onSave());
}
