import { Fragment } from "react";
import { cn } from "@/shared/lib/utils";
import { useEditorStore } from "@/Editor/editorStore";
import type { EditorSplitNode, LayoutNode } from "@/Editor/editorGrid";
import EditorSash from "./editor-sash";
import EditorGroupArea from "./editor-group";

/** Renders the editor split-layout tree (groups + sash-separated splits). */
export default function EditorGrid(): React.JSX.Element {
  const layout = useEditorStore((state) => state.layout);
  return <GridNode node={layout} />;
}

function childKey(node: LayoutNode): string {
  return node.type === "group" ? `g:${node.id}` : `s:${node.id}`;
}

function GridNode({ node }: { node: LayoutNode }): React.JSX.Element {
  if (node.type === "group") {
    return <EditorGroupArea groupId={node.id} />;
  }
  return <SplitArea node={node} />;
}

function SplitArea({ node }: { node: EditorSplitNode }): React.JSX.Element {
  const row = node.direction === "row";
  return (
    <div
      className={cn(
        "flex h-full w-full min-h-0 min-w-0 overflow-hidden",
        row ? "flex-col" : "flex-row"
      )}
    >
      {node.children.map((child, index) => (
        <Fragment key={childKey(child)}>
          {index > 0 && (
            <EditorSash
              splitId={node.id}
              index={index}
              direction={node.direction}
              sizes={node.sizes}
            />
          )}
          <div
            className="h-full w-full min-h-0 min-w-0 overflow-hidden"
            style={{
              flexGrow: node.sizes[index] ?? 1,
              flexShrink: 1,
              flexBasis: 0
            }}
          >
            <GridNode node={child} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}