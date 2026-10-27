import { Info, CheckCircle2, AlertTriangle, XCircle, Bot, X } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useAgentStore } from "../../agentStore";
import type { NotificationKind } from "../../types";

const ICONS: Record<NotificationKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
  agent: Bot
};

const ICON_COLORS: Record<NotificationKind, string> = {
  info: "text-blue-500",
  success: "text-green-500",
  warning: "text-amber-500",
  error: "text-red-500",
  agent: "text-primary"
};

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function NotificationToasts() {
  const notifications = useAgentStore((s) => s.notifications);
  const dismissNotification = useAgentStore((s) => s.dismissNotification);

  if (notifications.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {notifications.slice(0, 5).map((n) => {
        const Icon = ICONS[n.kind] || Info;
        const color = ICON_COLORS[n.kind] || "text-secondary";
        return (
          <div
            key={n.id}
            className="pointer-events-auto flex items-start gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest p-3 shadow-lg"
          >
            <Icon size={16} className={cn("mt-0.5 shrink-0", color)} />
            <div className="min-w-0 flex-1">
              <p className="font-label-md text-label-md font-medium text-on-surface">{n.title}</p>
              <p className="font-label-sm text-label-sm text-secondary">{n.message}</p>
              <p className="mt-0.5 font-label-xs text-label-xs text-secondary">{formatTime(n.timestamp)}</p>
            </div>
            <button
              type="button"
              onClick={() => dismissNotification(n.id)}
              aria-label={`Dismiss ${n.title}`}
              className="shrink-0 rounded p-1 text-secondary/60 transition-colors hover:bg-surface-container hover:text-on-surface"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
