import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/inter"; //For buttons text
import "@fontsource-variable/jetbrains-mono"; ///for terminals etc
import "@/theme/theme.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if (import.meta.env.DEV) {
  // Dev-only automation hook: exposes the zustand stores so CDP-driven
  // verification can open workspaces/files without clicking through the intro
  // screens. Never included in production bundles (DEV is false at build time).
  void Promise.all([
    import("@/Editor/editorStore"),
    import("@/Editor/fs/fileSystemStore"),
    import("@/Workspace/workspaceStore")
  ]).then(([{ useEditorStore }, { useFileSystemStore }, { useWorkspaceStore }]) => {
    (window as unknown as { __xvie?: unknown }).__xvie = {
      editor: useEditorStore,
      fs: useFileSystemStore,
      workspace: useWorkspaceStore
    };
  });
}
