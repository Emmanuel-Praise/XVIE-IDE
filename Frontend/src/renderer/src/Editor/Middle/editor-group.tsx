import DropTarget from "./drop-zones";
import EditorTabs from "./editor-tabs";
import EditorBreadcrumbs from "./editor-breadcrumbs";
import EditorCanvas from "./editor-canvas";

/**
 * A single editor group: tab strip + breadcrumbs + editor surface, wrapped in
 * a drop target so tabs/files can be dragged onto it or onto its edges.
 */
export default function EditorGroupArea({ groupId }: { groupId: string }): React.JSX.Element {
  return (
    <DropTarget groupId={groupId}>
      <EditorTabs groupId={groupId} />
      <EditorBreadcrumbs groupId={groupId} />
      <EditorCanvas groupId={groupId} />
    </DropTarget>
  );
}