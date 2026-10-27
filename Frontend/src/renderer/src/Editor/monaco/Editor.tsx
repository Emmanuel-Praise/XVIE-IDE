import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type { OnChange, OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorApi } from "monaco-editor";
import { Loader2 } from "lucide-react";
import { APP_DARK_THEME, defineAppDarkTheme, initMonacoProvider } from "./MonacoProvider";
import { attachEditorCommands, setActiveEditorGetter } from "./EditorCommands";
import {
  flushSessionPersistence,
  getOrCreateModel,
  restoreViewStateForModel,
  saveViewState
} from "./EditorModel";
import { persistEditorSession, useEditorStore } from "@/Editor/editorStore";
import { useThemeStore } from "@/theme/themeStore";

const PLACEHOLDER_PATH = "xvie://welcome";

interface MonacoEditorProps {
  groupId: string;
}

/** One editor instance per editor group, connected to Xvie's file store. */
export default function MonacoEditor({ groupId }: MonacoEditorProps): React.JSX.Element {
  const activeFile = useEditorStore((state) => state.groups[groupId]?.activeFile ?? "");
  const file = useEditorStore((state) =>
    activeFile ? state.files[activeFile] : undefined
  );
  const setFileContent = useEditorStore((state) => state.setFileContent);
  const autosave = useEditorStore((state) => state.autosave);
  const themeMode = useThemeStore((state) => state.mode);
  const editorRef = useRef<MonacoEditorApi.IStandaloneCodeEditor | null>(null);
  const activeFileRef = useRef(activeFile);
  const fileRef = useRef(file);
  const [ready, setReady] = useState(false);

  activeFileRef.current = activeFile;
  fileRef.current = file;

  useEffect(() => {
    void initMonacoProvider()
      .then(() => {
        defineAppDarkTheme();
        setReady(true);
      })
      .catch((error: unknown) => {
        console.error("Monaco initialization failed:", error);
      });
  }, []);

  // Synchronously snap the previous file's view state the moment this group
  // switches files (runs while the old model is still attached), then make sure
  // the next model exists so undo history + language survive.
  useEffect(() => {
    return useEditorStore.subscribe((state, previous) => {
      const prevGroup = previous.groups[groupId];
      const group = state.groups[groupId];
      if (!prevGroup || !group) return;
      if (prevGroup.activeFile === group.activeFile) return;
      const editor = editorRef.current;
      if (editor && prevGroup.activeFile) {
        const viewState = editor.saveViewState();
        if (viewState) saveViewState(prevGroup.activeFile, viewState);
      }
      const next = state.files[group.activeFile];
      if (group.activeFile && next && !next.loading) {
        getOrCreateModel(group.activeFile, next.content, next.languageId);
      }
      persistEditorSession();
    });
  }, [groupId]);

  useEffect(() => {
    const onExit = (): void => {
      const editor = editorRef.current;
      const path = activeFileRef.current;
      if (editor && path) {
        const viewState = editor.saveViewState();
        if (viewState) saveViewState(path, viewState);
      }
      persistEditorSession();
      flushSessionPersistence();
    };
    window.addEventListener("pagehide", onExit);
    window.addEventListener("beforeunload", onExit);
    return () => {
      window.removeEventListener("pagehide", onExit);
      window.removeEventListener("beforeunload", onExit);
    };
  }, []);

  useEffect(() => () => {
    persistEditorSession();
    flushSessionPersistence();
  }, []);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    setActiveEditorGetter(() => editorRef.current);
    attachEditorCommands(monaco, editor, {
      onSave: () => {
        const path = activeFileRef.current;
        if (path) useEditorStore.getState().saveNow(path);
      }
    });
    editor.onDidFocusEditorText(() => {
      setActiveEditorGetter(() => editorRef.current);
      useEditorStore.getState().setActiveGroup(groupId);
    });
    editor.onDidChangeModel(() => restoreViewStateForModel(editor));
    restoreViewStateForModel(editor);
  };

  const handleChange: OnChange = (value) => {
    const path = activeFileRef.current;
    const current = fileRef.current;
    if (!path || !current || current.content === (value ?? "")) return;
    setFileContent(path, value ?? "");
    void autosave(path);
  };

  if (!ready) {
    return <div className="flex h-full w-full items-center justify-center bg-editor-surface"><Loader2 size={24} className="animate-spin text-editor-text-dim" /></div>;
  }

  return (
    <Editor
      path={activeFile || PLACEHOLDER_PATH}
      value={activeFile ? file?.content ?? "" : ""}
      language={activeFile ? file?.languageId ?? "plaintext" : "plaintext"}
      theme={themeMode === "dark" ? APP_DARK_THEME : "vs"}
      options={{ automaticLayout: true }}
      saveViewState={false}
      keepCurrentModel
      loading={null}
      onMount={handleMount}
      onChange={handleChange}
    />
  );
}