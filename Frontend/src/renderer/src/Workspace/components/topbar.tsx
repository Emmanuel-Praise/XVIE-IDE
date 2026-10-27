import { useState } from "react";
import { Bell, HelpCircle, Menu, Search, Settings, User } from "lucide-react";

interface TopBarProps {
  onOpenMobileNav: () => void;
}

export default function TopBar({ onOpenMobileNav }: TopBarProps): React.JSX.Element {
  const [avatarError, setAvatarError] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex h-14 w-full items-center justify-between border-b border-outline-variant/40 bg-surface/80 px-margin-mobile backdrop-blur-md md:px-margin-desktop">
      <div className="flex items-center gap-5">
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Open navigation"
          className="cursor-pointer rounded-lg p-1.5 text-secondary transition-colors duration-150 hover:bg-surface-container-low hover:text-primary md:hidden"
        >
          <Menu size={20} />
        </button>
      </div>

      <button
        type="button"
        className="hidden w-80 items-center gap-2.5 rounded-lg border border-outline-variant/40 bg-surface-container-low/50 px-3 py-1.5 transition-all duration-150 hover:border-outline-variant hover:bg-surface-container-low md:flex"
      >
        <Search size={14} className="text-secondary/50" />
        <span className="font-body-sm text-body-sm text-secondary/50">Search</span>
      </button>

      <div className="flex items-center gap-0.5">
        <button
          type="button"
          className="relative cursor-pointer rounded-lg p-2 text-secondary transition-colors duration-150 hover:bg-surface-container-low hover:text-primary"
          aria-label="Notifications"
        >
          <Bell size={18} strokeWidth={1.8} />
          <span className="absolute top-1.5 right-1.5 h-[5px] w-[5px] rounded-full bg-primary ring-2 ring-surface" />
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-lg p-2 text-secondary transition-colors duration-150 hover:bg-surface-container-low hover:text-primary"
          aria-label="Settings"
        >
          <Settings size={18} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-lg p-2 text-secondary transition-colors duration-150 hover:bg-surface-container-low hover:text-primary"
          aria-label="Help"
        >
          <HelpCircle size={18} strokeWidth={1.8} />
        </button>
        <div className="ml-1.5 h-7 w-7 cursor-pointer overflow-hidden rounded-full border border-outline-variant/50 bg-surface-container-high transition-opacity hover:opacity-90">
          {avatarError ? (
            <User size={14} className="mx-auto mt-[7px] text-secondary" />
          ) : (
            <img
              alt="User avatar"
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuDne8YGgjllxi_1vx34mstlRG-hIKXp_ovoYKt26QxdjGONu0imqDOjsmEpOdEZFTppuqw0jDA8lEzDYvrZB1DtZLBJtHkAc4gT2HvSSvUA7iMx93WnS4JHBTpgoPQFg39kjwc-17hrsEJjKCPsgzK89yYA3FFlmoMhPBr8xZdX-ww0cxEt6SFPajtB9ZkMdzXZNwmuC6Q9vWxN3qv6c1sJJEE-NfMHkPVo4HzTreJY34DvHbExHIw2"
              onError={() => setAvatarError(true)}
              className="h-full w-full object-cover opacity-80 transition-opacity hover:opacity-100"
            />
          )}
        </div>
      </div>
    </header>
  );
}
