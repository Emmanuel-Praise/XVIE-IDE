import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, Code2, Search, Settings, User, PanelRightOpen, PanelRightClose, GitBranch } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useEditorStore } from "@/Editor/editorStore";
import { useAgentStore } from "@/Agent/agentStore";
import { useWorkspaceStore } from "@/Workspace/workspaceStore";
import SettingsPopover from "@/Editor/TopBar/settings-popover";
import { useRightPanelStore } from "@/RightPanel/rightPanelStore";

export default function EditorTopBar({ gitPage, onToggleGit }: { gitPage: boolean; onToggleGit: () => void }): React.JSX.Element {
  const setRailView = useEditorStore((state) => state.setRailView);
  const closeEditor = useWorkspaceStore((state) => state.closeEditor);
  const searchQuery = useEditorStore((state) => state.searchQuery);
  const setSearchQuery = useEditorStore((state) => state.setSearchQuery);
  const agentOpen = useAgentStore((state) => state.open);
  const setAgentOpen = useAgentStore((state) => state.setOpen);
  const settingsOpen = useEditorStore((state) => state.settingsOpen);
  const setSettingsOpen = useEditorStore((state) => state.setSettingsOpen);
  const rightPanelOpen = useRightPanelStore((state) => state.open);
  const toggleRightPanel = useRightPanelStore((state) => state.toggle);
  const [avatarError, setAvatarError] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleEditorPill = (): void => {
    if (agentOpen) {
      setAgentOpen(false);
      setRailView("explorer");
    }
  };

  const handleAgentPill = (): void => {
    setAgentOpen(!agentOpen);
    setSettingsOpen(false);
  };

  const handleSearchFocus = (): void => {
    setAgentOpen(false);
    setSettingsOpen(false);
    setRailView("search");
  };

  return (
    <header className="relative z-50 flex h-12 shrink-0 items-center justify-between gap-3 rounded-b-2xl border-b border-outline-variant bg-surface-container-lowest px-4 shadow-[0_2px_12px_rgba(0,0,0,0.05)]">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={closeEditor}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-body-md text-body-md text-secondary transition-colors duration-150 hover:bg-surface-container-low hover:text-primary"
        >
          <ArrowLeft size={15} strokeWidth={2} />
          Workspace
        </button>
        <span className="h-5 w-px bg-outline-variant" />
        <nav className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleEditorPill}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 font-body-md text-body-md transition-colors duration-150",
              !agentOpen
                ? "bg-primary font-bold text-on-primary"
                : "text-secondary hover:bg-surface-container-low hover:text-primary"
            )}
          >
            <Code2 size={14} strokeWidth={!agentOpen ? 2.2 : 1.8} />
            Editor
          </button>
          <button
            type="button"
            onClick={handleAgentPill}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 font-body-md text-body-md transition-colors duration-150",
              agentOpen
                ? "bg-primary font-bold text-on-primary"
                : "text-secondary hover:bg-surface-container-low hover:text-primary"
            )}
          >
            <Bot size={14} strokeWidth={agentOpen ? 2.2 : 1.8} />
            Agent
          </button>
        </nav>
      </div>

      <div className="hidden min-w-0 max-w-2xl flex-1 items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low px-3.5 py-2 transition-colors focus-within:border-primary md:flex">
        <Search size={14} className="shrink-0 text-secondary" />
        <input
          ref={searchRef}
          type="text"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onFocus={handleSearchFocus}
          placeholder="Search files in workspace…"
          className="w-full min-w-0 bg-transparent font-label-md text-label-md text-on-surface placeholder-secondary focus:outline-none"
        />
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={gitPage ? "Return to editor" : "Open Git"}
          title={gitPage ? "Return to editor" : "Open Git"}
          onClick={onToggleGit}
          className={cn("flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-label-md text-label-md transition-colors", gitPage ? "bg-primary text-on-primary" : "text-secondary hover:bg-surface-container-low hover:text-primary")}
        >
          <GitBranch size={15} strokeWidth={1.9} />Git
        </button>
        <button
          type="button"
          aria-label={rightPanelOpen ? "Hide right panel" : "Open right panel"}
          title="Xvie Agent and browser agents"
          onClick={toggleRightPanel}
          className="cursor-pointer rounded-lg p-2 text-secondary transition-colors hover:bg-surface-container-low hover:text-primary"
        >
          {rightPanelOpen ? <PanelRightClose size={16} strokeWidth={1.8} /> : <PanelRightOpen size={16} strokeWidth={1.8} />}
        </button>
        <button
          type="button"
          aria-label="Settings"
          onClick={() => {
            setSettingsOpen(!settingsOpen);
            setAgentOpen(false);
          }}
          className="cursor-pointer rounded-lg p-2 text-secondary transition-colors hover:bg-surface-container-low hover:text-primary"
        >
          <Settings size={16} strokeWidth={1.8} />
        </button>
        <div className="ml-0.5 h-7 w-7 shrink-0 overflow-hidden rounded-full border border-outline-variant bg-surface-container-high">
          {avatarError ? (
            <User size={14} className="mx-auto mt-[7px] text-secondary" />
          ) : (
            <img
              alt="User avatar"
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuDne8YGgjllxi_1vx34mstlRG-hIKXp_ovoYKt26QxdjGONu0imqDOjsmEpOdEZFTppuqw0jDA8lEzDYvrZB1DtZLBJtHkAc4gT2HvSSvUA7iMx93WnS4JHBTpgoPQFg39kjwc-17hrsEJjKCPsgzK89yYA3FFlmoMhPBr8xZdX-ww0cxEt6SFPajtB9ZkMdzXZNwmuC6Q9vWxN3qv6c1sJJEE-NfMHkPVo4HzTreJY34DvHbExHIw2"
              onError={() => setAvatarError(true)}
              className="h-full w-full object-cover"
            />
          )}
        </div>
      </div>

      {settingsOpen && (
        <>
          <button
            type="button"
            aria-label="Close settings"
            onClick={() => setSettingsOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <SettingsPopover onClose={() => setSettingsOpen(false)} />
        </>
      )}
    </header>
  );
}
