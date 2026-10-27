import type { TimelineStage } from "../types";

export function getCurrentStageLabel(stages: TimelineStage[]): string {
  const active = stages.find((s) => s.status === "active");
  if (active) return active.label;
  const completed = stages.filter((s) => s.status === "completed").length;
  return completed === stages.length ? "Completed" : "Queued";
}

export function getProgress(stages: TimelineStage[]): number {
  if (stages.length === 0) return 0;
  const completed = stages.filter((s) => s.status === "completed").length;
  const active = stages.find((s) => s.status === "active");
  const base = (completed / stages.length) * 100;
  const activeShare = active ? (active.progress / stages.length) * 0.6 : 0;
  return Math.min(Math.round(base + activeShare), 100);
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function formatClock(timestamp?: number): string {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
