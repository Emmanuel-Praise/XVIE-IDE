import { Moon, Sun, X } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useThemeStore, type ThemeMode } from "@/theme/themeStore";

interface SettingsPopoverProps {
  onClose: () => void;
}

const themeOptions: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: "light", label: "Light", icon: Sun },
  { mode: "dark", label: "Dark", icon: Moon }
];

export default function SettingsPopover({
  onClose
}: SettingsPopoverProps): React.JSX.Element {
  const mode = useThemeStore((state) => state.mode);
  const setMode = useThemeStore((state) => state.setMode);

  return (
    <div className="absolute right-2 top-full z-50 mt-2 w-72 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-[0_8px_32px_rgba(0,0,0,0.12)]">
      <div className="flex h-10 items-center justify-between border-b border-outline-variant px-3">
        <h2 className="font-label-md text-label-md font-bold uppercase tracking-wider text-on-surface">
          Settings
        </h2>
        <button
          type="button"
          aria-label="Close settings"
          onClick={onClose}
          className="cursor-pointer rounded p-1 text-secondary transition-colors hover:bg-surface-container-low hover:text-primary"
        >
          <X size={14} />
        </button>
      </div>

      <div className="p-3">
        <p className="pb-1.5 font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
          Appearance
        </p>
        <div className="flex gap-1 rounded-lg bg-surface-container-low p-1">
          {themeOptions.map(({ mode: optionMode, label, icon: Icon }) => {
            const active = mode === optionMode;
            return (
              <button
                key={optionMode}
                type="button"
                onClick={() => setMode(optionMode)}
                className={cn(
                  "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md py-1.5 font-label-md text-label-md transition-colors duration-150",
                  active
                    ? "bg-primary font-bold text-on-primary"
                    : "text-secondary hover:bg-surface-container-low hover:text-primary"
                )}
              >
                <Icon size={13} strokeWidth={active ? 2.2 : 1.8} />
                {label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 font-body-sm text-body-sm text-on-surface-variant">
          Theme changes apply instantly and are saved for next launch.
        </p>
      </div>

      <div className="border-t border-outline-variant px-3 py-2">
        <p className="font-label-sm text-label-sm text-on-tertiary-container">
          More settings coming soon.
        </p>
      </div>
    </div>
  );
}
