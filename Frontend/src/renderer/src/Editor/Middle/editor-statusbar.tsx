import { useEditorStore } from "@/Editor/editorStore";
import { languageLabel } from "@/Editor/monaco/LanguageRegistry";
import { isTerminalTab } from "@/Terminal/terminalTab";

export default function EditorStatusBar(): React.JSX.Element {
  const languageId = useEditorStore((state) => {
    const group = state.groups[state.activeGroupId];
    const active = group?.activeFile ?? "";
    if (!active || isTerminalTab(active)) return undefined;
    return state.files[active]?.languageId;
  });
  const activeIsTerminal = useEditorStore((state) => {
    const group = state.groups[state.activeGroupId];
    return !!group?.activeFile && isTerminalTab(group.activeFile);
  });
  const language = activeIsTerminal ? "Terminal" : languageId ? languageLabel(languageId) : "Plain Text";

  return (
    <footer className="z-50 flex h-7 shrink-0 items-center justify-end gap-3 border-t border-outline-variant/70 bg-editor-chrome px-2">
      <span className="flex items-center gap-2">
        <span className="cursor-default rounded px-2 py-0.5 font-label-sm text-label-sm text-editor-text-dim">
          {language}
        </span>
      </span>
    </footer>
  );
}
