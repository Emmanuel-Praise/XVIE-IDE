import { lazy, Suspense, useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import VideoIntro from "@/Intro/VideoIntro";
import ThemeChoice from "@/Intro/ThemeChoice";
import Login from "@/Intro/Login";

// Keep the intro responsive while the large editor and Monaco module graph loads.
const WorkspaceLayout = lazy(() => import("@/Workspace/components/workspace-layout"));

type View = "intro" | "theme" | "login" | "workspace";

export default function App(): React.JSX.Element {
  const [view, setView] = useState<View>(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("workspace")
      ? "workspace"
      : "intro"
  );

  useEffect(() => {
    // Warm the workspace chunk while the user is choosing a theme or signing in.
    if (view === "theme" || view === "login") {
      void import("@/Workspace/components/workspace-layout");
    }
  }, [view]);

  return (
    <div className="h-screen bg-background font-body-md text-on-background antialiased">
      <AnimatePresence mode="wait">
        {view === "intro" && <VideoIntro key="intro" onDone={() => setView("theme")} />}
        {view === "theme" && (
          <ThemeChoice key="theme" onDone={() => setView("login")} />
        )}
        {view === "login" && (
          <Login key="login" onDone={() => setView("workspace")} onBack={() => setView("theme")} />
        )}
        {view === "workspace" && (
          <Suspense fallback={null}>
            <WorkspaceLayout key="workspace" />
          </Suspense>
        )}
      </AnimatePresence>
    </div>
  );
}
