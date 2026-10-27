import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useThemeStore } from "@/theme/themeStore";
import darkVideo from "@/assets/DarkmodelogoVid.mp4?url";
import lightVideo from "@/assets/LightmodeXvielogo.mp4?url";

interface VideoIntroProps {
  onDone: () => void;
}

export default function VideoIntro({ onDone }: VideoIntroProps): React.JSX.Element {
  const mode = useThemeStore((state) => state.mode);
  const videoRef = useRef<HTMLVideoElement>(null);
  const onDoneRef = useRef(onDone);
  const [playbackError, setPlaybackError] = useState(false);
  const videoSrc = mode === "dark" ? darkVideo : lightVideo;
  const bgColor = mode === "dark" ? "#000000" : "#F5F5F5";

  // Keep the latest callback without restarting playback if the parent renders.
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let active = true;
    setPlaybackError(false);

    video.play().catch(() => {
      // React Strict Mode cancels the first play request during its deliberate
      // setup/cleanup cycle. Ignore that request and let the replacement play.
      if (active) setPlaybackError(true);
    });

    return () => {
      active = false;
      video.pause();
    };
  }, [videoSrc]);

  const continueAfterIntro = () => onDoneRef.current();

  return (
    <motion.div
      className="h-full w-full"
      style={{ backgroundColor: bgColor }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.6 }}
    >
      <div className="relative flex h-full w-full items-center justify-center" style={{ backgroundColor: bgColor }}>
        <video
          ref={videoRef}
          src={videoSrc}
          playsInline
          preload="auto"
          onEnded={continueAfterIntro}
          onError={() => setPlaybackError(true)}
          className="h-full w-full object-contain"
          style={{ backgroundColor: bgColor }}
        />
        {playbackError && (
          <div className="absolute bottom-6 right-6 flex flex-col items-end gap-3 sm:bottom-8 sm:right-8">
            <p className="font-body-sm text-secondary">The intro could not play.</p>
            <button type="button" onClick={continueAfterIntro} className="rounded-lg bg-primary px-4 py-2 font-label-sm text-label-sm font-medium text-on-primary">
              Continue to Xvie
            </button>
          </div>
        )}
        {!playbackError && (
          <button type="button" onClick={continueAfterIntro} className="absolute bottom-6 right-6 rounded-lg border border-outline-variant bg-surface-container-lowest/90 px-4 py-2 font-label-sm text-label-sm text-on-surface shadow-lg transition-colors hover:bg-surface-container sm:bottom-8 sm:right-8">
            Skip intro
          </button>
        )}
      </div>
    </motion.div>
  );
}
