import { Route, HelpCircle, Code2, Bug, Lightbulb } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AgentMode } from "../types";

export interface ModeInfo {
  id: AgentMode;
  label: string;
  icon: LucideIcon;
  badge: string;
  description: string;
}

export const AGENT_MODES: ModeInfo[] = [
  { id: "plan", label: "Plan", icon: Route, badge: "PLAN", description: "Map out the steps before acting" },
  { id: "ask", label: "Ask", icon: HelpCircle, badge: "ASK", description: "Questions about the codebase" },
  { id: "code", label: "Code", icon: Code2, badge: "CODE", description: "Write and edit code" },
  { id: "debug", label: "Debug", icon: Bug, badge: "DEBUG", description: "Find and fix problems" },
  { id: "brainstorm", label: "Brainstorm", icon: Lightbulb, badge: "IDEAS", description: "Explore ideas and trade-offs with web research" }
];

export function getModeInfo(mode: AgentMode): ModeInfo {
  return AGENT_MODES.find((m) => m.id === mode) ?? AGENT_MODES.find((m) => m.id === "code")!;
}
