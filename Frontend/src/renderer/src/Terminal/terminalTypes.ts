export type TerminalLocation = "panel" | "editor";

export type TerminalStatus = "starting" | "running" | "exited";

export interface TerminalSession {
  id: string;
  name: string;
  shell: string;
  cwd: string;
  location: TerminalLocation;
  status: TerminalStatus;
  exitCode?: number;
}

/** HTML5 DnD MIME used to drag terminal tabs between panel and editor. */
export const TERMINAL_DND_MIME = "application/x-xvie-terminal";
