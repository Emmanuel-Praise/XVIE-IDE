import { useRef, useState } from "react";
import { cn } from "@/shared/lib/utils";
import type { SplitDirection } from "@/Editor/editorGrid";
import { useEditorStore } from "@/Editor/editorStore";

interface EditorSashProps {
  splitId: string;
  /** Index into sizes of the right/bottom sibling. */
  index: number;
  direction: SplitDirection;
  sizes: number[];
}

const MIN_RATIO = 0.05;

/** The draggable divider between two editor groups. */
export default function EditorSash({ splitId, index, direction, sizes }: EditorSashProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const startCoord = useRef(0);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const left = Math.max(0, index - 1);

  const updateSizes = (deltaPx: number): void => {
    const container = ref.current?.parentElement;
    if (!container) return;
    const total = direction === "column" ? container.clientWidth : container.clientHeight;
    if (total <= 0) return;
    const a = sizes[left] ?? 1;
    const b = sizes[index] ?? 1;
    const base = a + b;
    let nextA = a + deltaPx / total;
    let nextB = base - nextA;
    if (nextA < MIN_RATIO) {
      nextA = MIN_RATIO;
      nextB = base - MIN_RATIO;
    }
    if (nextB < MIN_RATIO) {
      nextB = MIN_RATIO;
      nextA = base - MIN_RATIO;
    }
    const next = [...sizes];
    next[left] = nextA;
    next[index] = nextB;
    useEditorStore.getState().resizeSplit(splitId, next);
  };

  const handlePointerDown = (event: React.PointerEvent): void => {
    event.preventDefault();
    const node = ref.current;
    if (!node) return;
    startCoord.current = direction === "column" ? event.clientX : event.clientY;
    draggingRef.current = true;
    setDragging(true);
    node.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent): void => {
    if (!draggingRef.current) return;
    const coord = direction === "column" ? event.clientX : event.clientY;
    updateSizes(coord - startCoord.current);
  };

  const handlePointerUp = (event: React.PointerEvent): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    const node = ref.current;
    if (node?.hasPointerCapture(event.pointerId)) {
      node.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={ref}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={cn(
        "z-10 shrink-0 touch-none select-none",
        direction === "column"
          ? "h-full w-[5px] cursor-col-resize"
          : "h-[5px] w-full cursor-row-resize",
        dragging
          ? "bg-primary"
          : "bg-transparent transition-colors duration-150 hover:bg-primary/40"
      )}
    />
  );
}