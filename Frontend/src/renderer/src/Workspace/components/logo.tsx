import { cn } from "@/shared/lib/utils";
import { useThemeStore } from "@/theme/themeStore";
import logoLight from "@/assets/logo-light.png";
import logoDarkTransparent from "@/assets/logo-dark-transparent.png";

interface LogoProps {
  className?: string;
}

export default function Logo({ className }: LogoProps): React.JSX.Element {
  const mode = useThemeStore((state) => state.mode);
  // Dark surfaces use the background-free glyph so no box shows around it.
  const src = mode === "dark" ? logoDarkTransparent : logoLight;

  return (
    <img
      src={src}
      alt="Xvie Logo"
      className={cn("h-6 w-6 object-contain", className)}
      draggable={false}
    />
  );
}
