import { useState } from "react";
import {
  type LucideIcon,
  ArrowLeft,
  ChevronRight,
  Clipboard,
  ClipboardPaste,
  FileDown,
  FilePlus2,
  FileText,
  FolderOpen,
  HardDriveUpload,
  PanelBottomClose,
  Pencil,
  Redo2,
  Save,
  Scissors,
  Search,
  SquareTerminal,
  Trash2,
  Undo2,
  X
} from "lucide-react";
import { useEditorStore } from "@/Editor/editorStore";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";
import { useWorkspaceStore } from "@/Workspace/workspaceStore";
import { runEditorCommand } from "@/Editor/monaco/EditorCommands";

type MenuSection = "root" | "file" | "edit" | "terminal";

interface MenuItem {
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  action: () => void;
}

function MenuRow({
  item,
  withChevron
}: {
  item: MenuItem;
  withChevron?: boolean;
}): React.JSX.Element {
  const { label, icon: Icon, shortcut, action } = item;
  return (
    <button
      type="button"
      onClick={action}
      className="group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left font-label-md text-label-md text-on-surface transition-colors hover:bg-surface-container-low"
    >
      <Icon
        size={15}
        strokeWidth={1.8}
        className="shrink-0 text-secondary transition-colors group-hover:text-primary"
      />
      <span className="flex-1 truncate">{label}</span>
      {shortcut && (
        <kbd className="font-label-sm text-label-sm text-on-tertiary-container">{shortcut}</kbd>
      )}
      {withChevron && (
        <ChevronRight size={14} className="shrink-0 text-on-tertiary-container" />
      )}
    </button>
  );
}

export default function MenuPanel(): React.JSX.Element {
  const [menuSection, setMenuSection] = useState<MenuSection>("root");
  const setRailView = useEditorStore((state) => state.setRailView);
  const openFile = useEditorStore((state) => state.openFile);
  const setBottomTab = useEditorStore((state) => state.setBottomTab);
  const setBottomOpen = useEditorStore((state) => state.setBottomOpen);
  const clearTerminal = useEditorStore((state) => state.clearTerminal);
  const closeEditor = useWorkspaceStore((state) => state.closeEditor);

  const fileItems: MenuItem[] = [
    {
      label: "New File",
      icon: FilePlus2,
      shortcut: "Ctrl+N",
      action: () => openFile("untitled.js")
    },
    { label: "Open Folder", icon: FolderOpen, shortcut: "Ctrl+O",
      action: () => {
        void useFileSystemStore.getState().openWorkspace().then((opened) => {
          if (!opened) return;
          useEditorStore.getState().resetProject();
          setRailView("explorer");
        });
      } },
    {
      label: "Save",
      icon: Save,
      shortcut: "Ctrl+S",
      action: () => {
        const store = useEditorStore.getState();
        const active = store.groups[store.activeGroupId]?.activeFile ?? "";
        if (active) store.saveNow(active);
      }
    },
    { label: "Save As", icon: HardDriveUpload, shortcut: "Ctrl+Shift+S", action: () => undefined },
    { label: "Close Editor", icon: X, shortcut: "Ctrl+W", action: closeEditor }
  ];

  const editItems: MenuItem[] = [
    {
      label: "Undo",
      icon: Undo2,
      shortcut: "Ctrl+Z",
      action: () => runEditorCommand("editor.action.undo")
    },
    {
      label: "Redo",
      icon: Redo2,
      shortcut: "Ctrl+Y",
      action: () => runEditorCommand("editor.action.redo")
    },
    {
      label: "Cut",
      icon: Scissors,
      shortcut: "Ctrl+X",
      action: () => runEditorCommand("editor.action.clipboardCutAction")
    },
    {
      label: "Copy",
      icon: Clipboard,
      shortcut: "Ctrl+C",
      action: () => runEditorCommand("editor.action.clipboardCopyAction")
    },
    {
      label: "Paste",
      icon: ClipboardPaste,
      shortcut: "Ctrl+V",
      action: () => runEditorCommand("editor.action.clipboardPasteAction")
    },
    {
      label: "Find",
      icon: Search,
      shortcut: "Ctrl+F",
      action: () => runEditorCommand("actions.find")
    },
    {
      label: "Replace",
      icon: FileDown,
      shortcut: "Ctrl+H",
      action: () => runEditorCommand("editor.action.startFindReplaceAction")
    }
  ];

  const terminalItems: MenuItem[] = [
    {
      label: "Open Terminal",
      icon: SquareTerminal,
      shortcut: "Ctrl+`",
      action: () => {
        setBottomTab("terminal");
        setBottomOpen(true);
      }
    },
    {
      label: "Close Panel",
      icon: PanelBottomClose,
      shortcut: "Ctrl+J",
      action: () => setBottomOpen(false)
    },
    {
      label: "Clear Terminal",
      icon: Trash2,
      action: clearTerminal
    }
  ];

  const sections: Record<
    MenuSection,
    { title: string; items: MenuItem[]; root?: boolean }
  > = {
    root: {
      title: "File & Edit",
      root: true,
      items: [
        {
          label: "File",
          icon: FileText,
          action: () => setMenuSection("file")
        },
        {
          label: "Edit",
          icon: Pencil,
          action: () => setMenuSection("edit")
        },
        {
          label: "Terminal",
          icon: SquareTerminal,
          action: () => setMenuSection("terminal")
        }
      ]
    },
    file: { title: "File", items: fileItems },
    edit: { title: "Edit", items: editItems },
    terminal: { title: "Terminal", items: terminalItems }
  };

  const section = sections[menuSection];

  return (
    <div className="flex h-full w-72 shrink-0 flex-col overflow-hidden rounded-r-2xl border-r border-outline-variant bg-surface-container-lowest">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-outline-variant px-3">
        {!section.root && (
          <button
            type="button"
            aria-label="Back"
            onClick={() => setMenuSection("root")}
            className="mr-1 cursor-pointer rounded p-1 text-secondary transition-colors hover:bg-surface-container-low hover:text-primary"
          >
            <ArrowLeft size={15} />
          </button>
        )}
        <h2 className="flex-1 truncate font-label-md text-label-md font-bold uppercase tracking-wider text-on-surface">
          {section.title}
        </h2>
        {!section.root && (
          <button
            type="button"
            aria-label="Close"
            onClick={() => setRailView("menu")}
            className="cursor-pointer rounded p-1 text-secondary transition-colors hover:bg-surface-container-low hover:text-primary"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {section.items.map((item) => (
          <MenuRow
            key={item.label}
            item={item}
            withChevron={menuSection === "root"}
          />
        ))}
      </div>
      {menuSection === "root" && (
        <div className="shrink-0 border-t border-outline-variant px-3 py-2">
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Menus moved to the rail. Click any entry to explore its options.
          </p>
        </div>
      )}
    </div>
  );
}
