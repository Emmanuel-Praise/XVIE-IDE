import { type LucideIcon, LayoutDashboard, Store, Folder, History } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import Logo from "@/Workspace/components/logo";
import { useWorkspaceStore, type WorkspaceTab } from "@/Workspace/workspaceStore";

interface NavItem {
  tab: WorkspaceTab;
  label: string;
  icon: LucideIcon;
}

export const workspaceNavItems: NavItem[] = [
  { tab: "overview", label: "Overview", icon: LayoutDashboard },
  { tab: "marketplace", label: "Marketplace", icon: Store },
  { tab: "projects", label: "Projects", icon: Folder },
  { tab: "history", label: "History", icon: History }
];

interface SidebarProps {
  onNavigate?: () => void;
}

export default function Sidebar({ onNavigate }: SidebarProps): React.JSX.Element {
  const activeTab = useWorkspaceStore((state) => state.activeTab);
  const setTab = useWorkspaceStore((state) => state.setTab);

  return (
    <nav className="relative flex h-full w-64 shrink-0 flex-col overflow-hidden border-r border-outline-variant/40 bg-gradient-to-b from-surface to-surface-container-low">
      <div className="absolute inset-y-0 left-0 w-[2px] bg-primary/20" />

      <div className="px-md pt-lg pb-sm">
        <div className="flex items-center gap-3 rounded-lg px-2 py-1.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-container p-1.5">
            <Logo className="h-full w-full" />
          </div>
          <div className="min-w-0">
            <h2 className="line-clamp-1 font-headline-sm text-headline-sm font-semibold text-primary">
              Xvie
            </h2>
            <p className="mt-px font-label-sm text-label-sm text-secondary">
              workspace
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-md py-2">
        <p className="mb-2 px-3 pt-2 font-label-sm text-label-sm uppercase tracking-wider text-secondary/50">
          Navigation
        </p>
        {workspaceNavItems.map(({ tab, label, icon: Icon }) => {
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => {
                setTab(tab);
                onNavigate?.();
              }}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 font-label-md text-label-md transition-all duration-150 ease-in-out",
                active
                  ? "bg-primary/8 border-l-2 border-primary text-primary"
                  : "border-l-2 border-transparent text-secondary hover:bg-surface-container-low/50 hover:text-primary"
              )}
            >
              <Icon
                size={18}
                strokeWidth={active ? 2 : 1.6}
                className={cn("shrink-0", active ? "text-primary" : "text-secondary")}
              />
              <span className={cn(active && "font-medium")}>{label}</span>
            </button>
          );
        })}
      </div>

      <div className="border-t border-outline-variant/30 px-md py-3">
        <div className="flex items-center gap-2 px-3">
          <div className="h-1.5 w-1.5 rounded-full bg-emerald-500/80" />
          <span className="font-label-sm text-label-sm text-secondary/60">Ready</span>
        </div>
      </div>
    </nav>
  );
}
