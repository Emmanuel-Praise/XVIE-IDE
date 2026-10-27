/**
 * Terminal tabs live inside the normal editor tab strips as `terminal:<id>`
 * entries, so they split, drag and close exactly like file tabs. This module
 * is intentionally dependency-free (both editor and terminal stores use it).
 */

export const TERMINAL_TAB_PREFIX = "terminal:";

export function isTerminalTab(tab: string): boolean {
  return tab.startsWith(TERMINAL_TAB_PREFIX);
}

export function terminalIdOfTab(tab: string): string {
  return tab.slice(TERMINAL_TAB_PREFIX.length);
}

export function terminalTabOf(id: string): string {
  return `${TERMINAL_TAB_PREFIX}${id}`;
}
