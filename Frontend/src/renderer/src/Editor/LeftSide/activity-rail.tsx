import {
  type LucideIcon,
  Folder,
  GitBranch,
  Menu,
  Search
} from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useEditorStore, type RailView } from "@/Editor/editorStore";

interface RailItem {
  view: RailView;
  label: string;
  icon: LucideIcon;
}

const railItems: RailItem[] = [
  { view: "menu", label: "File & Edit", icon: Menu },
  { view: "explorer", label: "Explorer", icon: Folder },
  { view: "search", label: "Search", icon: Search },
  { view: "git", label: "Source Control", icon: GitBranch }
];

function RailButton({
  item,
  active,
  onClick
}: {
  item: RailItem;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const { label, icon: Icon } = item;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "group relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg transition-all duration-150",
        active
          ? "bg-primary text-on-primary shadow-[0_2px_8px_rgba(0,0,0,0.18)]"
          : "text-on-tertiary-container hover:bg-surface-container-high hover:text-primary"
      )}
    >
      <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
      <span className="pointer-events-none absolute left-full z-50 ml-2 whitespace-nowrap rounded-md bg-inverse-surface px-2 py-1 font-label-sm text-label-sm text-inverse-on-surface opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100">
        {label}
      </span>
    </button>
  );
}

export default function ActivityRail(): React.JSX.Element {
  const railView = useEditorStore((state) => state.railView);
  const setRailView = useEditorStore((state) => state.setRailView);

  return (
    <nav className="flex w-12 shrink-0 flex-col items-center justify-start self-stretch rounded-r-2xl border-r border-outline-variant bg-surface-container-low py-3">
      <div className="flex flex-col items-center gap-1.5">
        {railItems.map((item) => (
          <RailButton
            key={item.view}
            item={item}
            active={railView === item.view}
            onClick={() => setRailView(item.view)}
          />
        ))}
      </div>
    </nav>
  );
}
