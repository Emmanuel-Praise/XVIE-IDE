/*
 * Pure data structure + operations for the editor split layout.
 *
 * The layout is a tree:
 *   - "group" leaves: reference an id into the editor store's groups map.
 *   - "split" nodes: row (stacked vertically) or column (side-by-side).
 */

import type { CsvViewMode, MarkdownViewMode } from "./editorStore";

export type SplitDirection = "row" | "column";

/** Which side of a reference group a new group should land on. */
export type SplitSide = "left" | "right" | "top" | "bottom";

export interface EditorSplitNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  children: LayoutNode[];
  sizes: number[];
}

export type LayoutNode = { type: "group"; id: string } | EditorSplitNode;

export interface EditorGroup {
  id: string;
  tabs: string[];
  activeFile: string;
  markdownViewMode: MarkdownViewMode;
  csvViewMode: CsvViewMode;
}

let idCounter = 1;

function makeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${Date.now().toString(36)}-${rand}-${(idCounter++).toString(36)}`;
}

export function createGroupId(): string {
  return makeId("group");
}

export function createSplitId(): string {
  return makeId("split");
}

export function isSplitNode(node: LayoutNode): node is EditorSplitNode {
  return node.type === "split";
}

export function createGroupNode(id: string): LayoutNode {
  return { type: "group", id };
}

export function createEmptyGroup(id: string): EditorGroup {
  return { id, tabs: [], activeFile: "", markdownViewMode: "source", csvViewMode: "grid" };
}

export function cloneGroup(group: EditorGroup): EditorGroup {
  return { ...group, id: createGroupId(), tabs: [...group.tabs], activeFile: group.activeFile };
}

export function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + (size > 0 ? size : 0), 0);
  if (total <= 0) return sizes.map(() => 1);
  return sizes.map((size) => (size > 0 ? size : 0) / total);
}

/** Gathers all group ids in tree (render) order. */
export function getGroupIds(node: LayoutNode): string[] {
  if (node.type === "group") return [node.id];
  return node.children.flatMap(getGroupIds);
}

export function countGroups(node: LayoutNode): number {
  return getGroupIds(node).length;
}

/** Flattens a same-direction child split into the parent, preserving ratios. */
function maybeFlatten(node: EditorSplitNode): EditorSplitNode {
  if (node.children.length !== node.sizes.length) {
    node.sizes = normalizeSizes(node.sizes);
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const share = node.sizes[index] ?? 1;
    if (isSplitNode(child) && child.direction === node.direction) {
      const childTotal = child.sizes.reduce((sum, s) => sum + s, 0) || 1;
      children.push(...child.children);
      sizes.push(...child.sizes.map((size) => (share * size) / childTotal));
    } else {
      children.push(child);
      sizes.push(share);
    }
  });
  return { ...node, children, sizes: normalizeSizes(sizes) };
}

/**
 * Splits the group `groupId` into two, placing the new group after (right/bottom).
 * Returns a new tree; the original is untouched.
 */
export function splitGroupAt(
  tree: LayoutNode,
  groupId: string,
  direction: SplitDirection,
  newGroupId: string
): LayoutNode {
  if (tree.type === "group") {
    if (tree.id !== groupId) return tree;
    return {
      type: "split",
      id: createSplitId(),
      direction,
      children: [tree, createGroupNode(newGroupId)],
      sizes: [1, 1]
    };
  }
  const children = tree.children.map((child) =>
    splitGroupAt(child, groupId, direction, newGroupId)
  );
  if (children.every((child, i) => child === tree.children[i])) return tree;
  return maybeFlatten({ ...tree, children });
}

/**
 * Inserts a brand-new group next to `refGroupId` on the given side.
 * If the reference already lives inside a same-direction split, the new group
 * slots in adjacent to it; otherwise the reference gets wrapped in a new split.
 */
export function insertNewGroupAt(
  tree: LayoutNode,
  refGroupId: string,
  side: SplitSide,
  newGroupId: string
): LayoutNode {
  if (tree.type === "group") {
    if (tree.id !== refGroupId) return tree;
    const direction: SplitDirection =
      side === "left" || side === "right" ? "column" : "row";
    const before = side === "left" || side === "top";
    return {
      type: "split",
      id: createSplitId(),
      direction,
      children: before
        ? [createGroupNode(newGroupId), tree]
        : [tree, createGroupNode(newGroupId)],
      sizes: [1, 1]
    };
  }
  const children = tree.children.map((child) =>
    insertNewGroupAt(child, refGroupId, side, newGroupId)
  );
  if (children.every((child, i) => child === tree.children[i])) return tree;
  return maybeFlatten({ ...tree, children });
}

/**
 * Removes the group leaf from the tree, pruning orphaned splits.
 * Returns the surviving tree and whether the removal happened. A `null` node
 * means the tree would be empty.
 */
export function removeGroupFromTree(
  tree: LayoutNode,
  groupId: string
): { node: LayoutNode | null; removed: boolean } {
  if (tree.type === "group") {
    return { node: tree.id === groupId ? null : tree, removed: tree.id === groupId };
  }
  const nextChildren: LayoutNode[] = [];
  const nextSizes: number[] = [];
  let removed = false;
  tree.children.forEach((child, index) => {
    const result = removeGroupFromTree(child, groupId);
    if (result.removed) {
      removed = true;
      return;
    }
    if (result.node) {
      nextChildren.push(result.node);
      nextSizes.push(tree.sizes[index] ?? 1);
    }
  });
  if (!removed) return { node: tree, removed: false };
  if (nextChildren.length === 1) return { node: nextChildren[0], removed: true };
  if (nextChildren.length === 0) return { node: null, removed: true };
  return {
    node: { ...tree, children: nextChildren, sizes: normalizeSizes(nextSizes) },
    removed: true
  };
}

/** Replaces the sizes of a split node identified by its id. */
export function updateSplitSizes(
  tree: LayoutNode,
  splitId: string,
  sizes: number[]
): LayoutNode {
  if (tree.type === "group") return tree;
  if (tree.id === splitId) return { ...tree, sizes: normalizeSizes(sizes) };
  const children = tree.children.map((child) => updateSplitSizes(child, splitId, sizes));
  if (children.every((child, i) => child === tree.children[i])) return tree;
  return { ...tree, children };
}