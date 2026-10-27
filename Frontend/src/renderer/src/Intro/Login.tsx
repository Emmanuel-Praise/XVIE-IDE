import { motion } from "framer-motion";
import { ArrowLeft, Code, Globe, Mail, WifiOff } from "lucide-react";
import { Button } from "@/shared/components/button";
import { PageLayout } from "@/shared/components/page-layout";
import { useThemeStore } from "@/theme/themeStore";
import logoLight from "@/assets/logo-light.png";
import logoDark from "@/assets/logo-dark.png";

interface LoginProps {
  onDone: () => void;
  onBack: () => void;
}

export default function Login({ onDone, onBack }: LoginProps): React.JSX.Element {
  const mode = useThemeStore((state) => state.mode);
  const logo = mode === "dark" ? logoDark : logoLight;

  return (
    <motion.div
      className="h-full w-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
    >
      <PageLayout>
        <div className="w-full max-w-[22rem]">
          <div className="mb-lg flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-2">
              <img src={logo} alt="Xvie Logo" className="h-full w-full object-contain" />
            </div>
            <div>
              <h1 className="font-headline-md text-headline-md text-primary">Welcome back</h1>
              <p className="font-body-sm text-body-sm text-secondary">Sign in to continue</p>
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            <Button variant="default" className="w-full justify-start gap-3" onClick={onDone}>
              <Code size={16} strokeWidth={2} />
              Continue with GitHub
            </Button>

            <div className="relative my-1">
              <div className="flex items-center gap-3">
                <div className="flex-1 border-t border-outline-variant/40" />
                <span className="font-body-sm text-body-sm text-secondary/60">other options</span>
                <div className="flex-1 border-t border-outline-variant/40" />
              </div>
            </div>

            <button
              type="button"
              onClick={onDone}
              className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-2.5 font-label-md text-label-md text-secondary transition-all duration-150 hover:bg-surface-container-low hover:text-primary"
            >
              <Globe size={16} strokeWidth={1.8} />
              Continue with Google
            </button>

            <button
              type="button"
              onClick={onDone}
              className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-2.5 font-label-md text-label-md text-secondary transition-all duration-150 hover:bg-surface-container-low hover:text-primary"
            >
              <Mail size={16} strokeWidth={1.8} />
              Continue with Email
            </button>

            <button
              type="button"
              onClick={onDone}
              className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-2.5 font-label-md text-label-md text-secondary transition-all duration-150 hover:bg-surface-container-low hover:text-primary"
            >
              <WifiOff size={16} strokeWidth={1.8} />
              Work offline
            </button>
          </div>

          <div className="mt-xl flex items-center justify-between">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex cursor-pointer items-center gap-1.5 font-label-sm text-label-sm text-secondary transition-colors duration-150 hover:text-primary"
            >
              <ArrowLeft size={13} />
              Back
            </button>
            <p className="font-body-sm text-body-sm text-secondary/50">
              Your data stays on your device
            </p>
          </div>
        </div>
      </PageLayout>
    </motion.div>
  );
}
