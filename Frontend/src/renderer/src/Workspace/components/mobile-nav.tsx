import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import Sidebar from "@/Workspace/components/sidebar";

interface MobileNavProps {
  open: boolean;
  onClose: () => void;
}

export default function MobileNav({ open, onClose }: MobileNavProps): React.JSX.Element {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px] md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.aside
            className="fixed inset-y-0 left-0 z-50 md:hidden"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ type: "tween", duration: 0.25, ease: "easeOut" }}
          >
            <div className="flex h-full">
              <Sidebar onNavigate={onClose} />
              <button
                type="button"
                onClick={onClose}
                aria-label="Close navigation"
                className="flex h-fit items-center gap-2 rounded-lg bg-black/50 p-3 font-label-md text-label-md text-white backdrop-blur-sm"
              >
                <X size={20} />
                Close
              </button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
