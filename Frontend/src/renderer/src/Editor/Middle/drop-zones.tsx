import { useState } from "react";
import { cn } from "@/shared/lib/utils";
import { useEditorStore } from "@/Editor/editorStore";
import { terminalTabOf } from "@/Terminal/terminalTab";
import type { SplitSide } from "@/Editor/editorGrid";

/*
 * Native HTML5 drag & drop for moving tabs/files between (and onto edges of)
 * editor groups. The payload is mirrored in a module-level variable because
 * custom MIME types on the DataTransfer are only readable during the drop.
 */

export type EditorDragPayload =
  | { kind: "tab"; path: string; fromGroupId: string }
  | { kind: "file"; path: string }
  | { kind: "terminal"; terminalId: string; fromGroupId?: string };

let globalDragPayload: EditorDragPayload | null = null;

export function setEditorDragPayload(payload: EditorDragPayload | null): void {
  globalDragPayload = payload;
}

export function getEditorDragPayload(): EditorDragPayload | null {
  return globalDragPayload;
}

const EDGE_STRIP = 24;

type DropZone = SplitSide | "center" | null;

function resolveZone(event: React.DragEvent): DropZone {
  if (!getEditorDragPayload()) return null;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  if (x < EDGE_STRIP) return "left";
  if (rect.width - x < EDGE_STRIP) return "right";
  if (y < EDGE_STRIP) return "top";
  if (rect.height - y < EDGE_STRIP) return "bottom";
  return "center";
}

interface DropTargetProps {
  groupId: string;
  children: React.ReactNode;
}

function DropTargetInner({ groupId, children }: DropTargetProps): React.JSX.Element {
  const [zone, setZone] = useState<DropZone>(null);

  const handleDragOver = (event: React.DragEvent): void => {
    if (!getEditorDragPayload()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setZone(resolveZone(event));
  };

  const handleDragLeave = (event: React.DragEvent): void => {
    const target = event.target as Node;
    const next = event.relatedTarget as Node | null;
    if (next && target.contains(next)) return;
    setZone(null);
  };

  const handleDrop = (event: React.DragEvent): void => {
    event.preventDefault();
    const payload = getEditorDragPayload();
    setZone(null);
    if (!payload) return;
    const store = useEditorStore.getState();
    const zone = resolveZone(event) ?? "center";

    if (payload.kind === "file") {
      if (zone === "center") {
        void store.openFile(payload.path, groupId);
      } else {
        store.splitWithFile(payload.path, groupId, zone);
      }
      return;
    }

    if (payload.kind === "tab") {
      if (zone === "center") {
        store.moveTabToGroup(payload.path, payload.fromGroupId, groupId);
      } else {
        store.splitWithFile(payload.path, groupId, zone, payload.fromGroupId);
      }
      return;
    }

    if (payload.kind === "terminal") {
      if (zone === "center") {
        if (payload.fromGroupId && payload.fromGroupId !== groupId) {
          store.moveTabToGroup(
            terminalTabOf(payload.terminalId),
            payload.fromGroupId,
            groupId
          );
        } else {
          store.openTerminalTab(payload.terminalId, groupId);
        }
      } else {
        store.splitWithTerminal(payload.terminalId, groupId, zone, payload.fromGroupId);
      }
    }
  };

  return (
    <div
      className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
      {zone && (
        <>
          <div className="pointer-events-none absolute inset-0 z-20 bg-primary/5" />
          {zone !== "center" && (
            <div
              className={cn(
                "pointer-events-none absolute z-20 bg-primary/30",
                zone === "left" && "inset-y-0 left-0 w-1.5",
                zone === "right" && "inset-y-0 right-0 w-1.5",
                zone === "top" && "inset-x-0 top-0 h-1.5",
                zone === "bottom" && "inset-x-0 bottom-0 h-1.5"
              )}
            />
          )}
        </>
      )}
    </div>
  );
}

export default DropTargetInner;