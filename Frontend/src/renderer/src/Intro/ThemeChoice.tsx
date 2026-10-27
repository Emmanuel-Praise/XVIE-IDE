import { motion } from "framer-motion";
import { PageLayout } from "@/shared/components/page-layout";
import { useThemeStore, type ThemeMode } from "@/theme/themeStore";

interface ThemeChoiceProps {
  onDone: () => void;
}

const themes: Array<{
  mode: ThemeMode;
  label: string;
  description: string;
  colors: string[];
}> = [
  {
    mode: "light",
    label: "Light",
    description: "Clean and bright",
    colors: ["#F5F5F5", "#ffffff", "#e5e3e0", "#1a1917"]
  },
  {
    mode: "dark",
    label: "Dark",
    description: "Easy on the eyes",
    colors: ["#000000", "#21201e", "#4a4845", "#c8c5c0"]
  }
];

export default function ThemeChoice({ onDone }: ThemeChoiceProps): React.JSX.Element {
  const setMode = useThemeStore((state) => state.setMode);

  function choose(mode: ThemeMode): void {
    setMode(mode);
    onDone();
  }

  return (
    <motion.div
      className="h-full w-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
    >
      <PageLayout className="gap-xl">
        <div className="text-center">
          <h1 className="font-headline-md text-headline-md text-primary">Choose your theme</h1>
          <p className="mt-sm font-body-md text-body-md text-secondary">
            Pick a look for Xvie. You can always switch later.
          </p>
        </div>

        <div className="flex w-full max-w-[28rem] flex-col gap-lg md:flex-row">
          {themes.map(({ mode, label, description, colors }, index) => (
            <motion.button
              key={mode}
              type="button"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: index * 0.1 }}
              onClick={() => choose(mode)}
              className="group flex flex-1 cursor-pointer flex-col items-center gap-4 rounded-2xl border border-outline-variant/50 bg-surface-container-lowest p-6 transition-all duration-200 hover:-translate-y-1 hover:border-outline hover:shadow-[0_8px_30px_-6px_rgba(0,0,0,0.12)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary dark:hover:shadow-[0_8px_30px_-6px_rgba(0,0,0,0.4)]"
            >
              <div className="flex w-full gap-2">
                {colors.map((color, i) => (
                  <div
                    key={i}
                    className="h-12 flex-1 rounded-lg border border-outline-variant/30 transition-transform duration-200 group-hover:scale-105"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              <div className="text-center">
                <span className="font-headline-sm text-headline-sm text-primary block">{label}</span>
                <span className="font-body-sm text-body-sm text-secondary">{description}</span>
              </div>
            </motion.button>
          ))}
        </div>
      </PageLayout>
    </motion.div>
  );
}
