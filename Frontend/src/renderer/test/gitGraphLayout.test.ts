import { describe, expect, it } from "vitest";
import type { GitCommit } from "../../shared/ipc-types";
import { buildGitGraphLayout, commitChangeTotals } from "../src/Git/gitGraphLayout";

const commit = (hash: string, parents: string[] = [], refs: string[] = [], insertions = 2, deletions = 1): GitCommit => ({
  hash, parents, author: "Test User", email: "test@example.com", date: "2026-10-16T12:00:00Z", message: `commit ${hash}`,
  refs, files: [`${hash}.txt`], fileChanges: [{ path: `${hash}.txt`, status: "modified", insertions, deletions, binary: false }], insertions, deletions
});

const layout = (commits: GitCommit[], currentBranch = "main", branchNames = ["main"], openBranches: string[] = []) =>
  buildGitGraphLayout(commits, { currentBranch, branchNames, openBranches: new Set(openBranches), expandedGroups: new Set(), spacing: "compact" });

const assertOnlyRealEdges = (commits: GitCommit[], graph: ReturnType<typeof layout>): void => {
  const actual = new Set(commits.flatMap((child) => child.parents.map((parent) => `${parent}>${child.hash}`)));
  for (const edge of graph.parentEdges) expect(actual.has(`${edge.parentHash}>${edge.childHash}`)).toBe(true);
};

const assertNoCardOverlaps = (graph: ReturnType<typeof layout>): void => {
  const boxes = [
    ...graph.visibleGroups.map((index) => {
      const point = graph.positions.get(index)!;
      const height = graph.groupHeights.get(index) ?? 160;
      return { left: point.x - graph.cardWidth / 2, right: point.x + graph.cardWidth / 2, top: point.y - 80, bottom: point.y - 80 + height };
    }),
    ...graph.visibleBranches.map((branch) => {
      const point = graph.branchPositions.get(branch.key)!;
      return { left: point.x - graph.branchCardWidth / 2, right: point.x + graph.branchCardWidth / 2, top: point.y - 84, bottom: point.y + 84 };
    })
  ];
  for (let left = 0; left < boxes.length; left += 1) for (let right = left + 1; right < boxes.length; right += 1) {
    const a = boxes[left]; const b = boxes[right];
    expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
  }
  for (const routeY of graph.rowGapRoutes.values()) for (const offset of [0, 3, 6, 9]) {
    const y = routeY + offset;
    for (const box of boxes) expect(y <= box.top || y >= box.bottom).toBe(true);
  }
};

describe("Git graph layout", () => {
  it("groups a straight history and draws only its actual parent edges", () => {
    const commits = [commit("a"), commit("b", ["a"]), commit("c", ["b"], ["HEAD -> main", "main"] )];
    const graph = layout(commits);
    expect(graph.grouped).toHaveLength(2);
    expect(graph.grouped[0].commits.map((item) => item.hash)).toEqual(["a", "b"]);
    expect(graph.visibleGroups).toHaveLength(2);
    assertOnlyRealEdges(commits, graph);
    assertNoCardOverlaps(graph);
  });

  it("uses file-level numstat as the displayed line-change source", () => {
    const mismatched = { ...commit("stats"), insertions: 0, deletions: 0 };
    expect(commitChangeTotals(mismatched)).toEqual({ insertions: 2, deletions: 1 });
  });

  it("folds a merged side history at its fork and restores its real parent links when opened", () => {
    const commits = [commit("a"), commit("b", ["a"]), commit("c", ["b"]), commit("d", ["b", "c"], ["HEAD -> main", "main"] )];
    const folded = layout(commits);
    const branch = folded.branches.find((item) => item.mergeHash === "d");
    expect(branch).toBeDefined();
    expect(folded.visibleGroups.some((index) => folded.grouped[index].commits.some((item) => item.hash === "c"))).toBe(false);
    expect(folded.grouped[folded.groupForHash.get("d")!].row - folded.grouped[folded.groupForHash.get("b")!].row).toBe(1);
    expect(folded.foldedForkEdges).toContainEqual({ branchKey: branch!.key, fromGroup: folded.groupForHash.get("b") });
    expect(folded.foldedMergeEdges).toContainEqual({ branchKey: branch!.key, toGroup: folded.groupForHash.get("d") });
    const opened = layout(commits, "main", ["main"], [branch!.key]);
    expect(opened.visibleGroups.some((index) => opened.grouped[index].commits.some((item) => item.hash === "c"))).toBe(true);
    expect(opened.parentEdges).toContainEqual(expect.objectContaining({ parentHash: "c", childHash: "d" }));
    expect(opened.foldedMergeEdges).toHaveLength(0);
    assertOnlyRealEdges(commits, opened);
    assertNoCardOverlaps(folded);
    assertNoCardOverlaps(opened);
  });

  it("keeps a long folded side history from creating blank space in the trunk", () => {
    const commits = [
      commit("a"), commit("b", ["a"]),
      commit("s1", ["b"]), commit("s2", ["s1"]), commit("s3", ["s2"]), commit("s4", ["s3"]), commit("s5", ["s4"]),
      commit("t1", ["b"]), commit("m", ["t1", "s5"]), commit("head", ["m"], ["HEAD -> main", "main"])
    ];
    const graph = layout(commits);
    expect(graph.grouped[graph.groupForHash.get("m")!].row).toBe(graph.grouped[graph.groupForHash.get("t1")!].row + 1);
    expect(graph.visibleGroups.some((index) => graph.grouped[index].commits.some((item) => item.hash === "s3"))).toBe(false);
    assertNoCardOverlaps(graph);
    const branch = graph.branches.find((item) => item.mergeHash === "m")!;
    const opened = layout(commits, "main", ["main"], [branch.key]);
    expect(opened.grouped[opened.groupForHash.get("m")!].row).toBe(opened.grouped[opened.groupForHash.get("t1")!].row + 1);
    assertNoCardOverlaps(opened);
  });

  it("keeps nested branches folded until each branch summary is opened", () => {
    const commits = [commit("a"), commit("b", ["a"]), commit("c", ["b"]), commit("n", ["c"]), commit("m", ["c", "n"]), commit("z", ["b", "m"], ["HEAD -> main", "main"] )];
    const folded = layout(commits);
    const outer = folded.branches.find((item) => item.mergeHash === "z")!;
    const outerOpen = layout(commits, "main", ["main"], [outer.key]);
    expect(outerOpen.visibleBranches.some((item) => item.mergeHash === "m")).toBe(true);
    expect(outerOpen.visibleGroups.some((index) => outerOpen.grouped[index].commits.some((item) => item.hash === "n"))).toBe(false);
    const inner = outerOpen.visibleBranches.find((item) => item.mergeHash === "m")!;
    const bothOpen = layout(commits, "main", ["main"], [outer.key, inner.key]);
    expect(bothOpen.visibleGroups.some((index) => bothOpen.grouped[index].commits.some((item) => item.hash === "n"))).toBe(true);
    assertOnlyRealEdges(commits, bothOpen);
    assertNoCardOverlaps(folded);
    assertNoCardOverlaps(outerOpen);
    assertNoCardOverlaps(bothOpen);
  });

  it("shows an unmerged named branch summary and expands it without a checkout change", () => {
    const commits = [commit("a"), commit("b", ["a"], ["main"]), commit("c", ["b"], ["HEAD -> feature", "feature"] )];
    const folded = layout(commits, "main", ["feature", "main"]);
    const branch = folded.branches.find((item) => item.mergeHash === null && item.name === "feature");
    expect(branch).toBeDefined();
    expect(folded.visibleGroups.some((index) => folded.grouped[index].commits.some((item) => item.hash === "c"))).toBe(false);
    const opened = layout(commits, "main", ["feature", "main"], [branch!.key]);
    expect(opened.visibleGroups.some((index) => opened.grouped[index].commits.some((item) => item.hash === "c"))).toBe(true);
    assertNoCardOverlaps(folded);
    assertNoCardOverlaps(opened);
  });

  it("recovers merged history with deleted refs", () => {
    const commits = [commit("a"), commit("b", ["a"]), commit("orphan", ["a"]), commit("merge", ["b", "orphan"], ["HEAD -> main", "main"] )];
    const graph = layout(commits);
    expect(graph.branches.some((branch) => branch.mergeHash === "merge" && branch.name === "Merged branch 1")).toBe(true);
  });

  it("handles a single commit and an octopus merge", () => {
    const single = layout([commit("only", [], ["HEAD -> main", "main"] )]);
    expect(single.visibleGroups).toHaveLength(1);
    expect(single.parentEdges).toHaveLength(0);

    const commits = [commit("root"), commit("left", ["root"]), commit("right", ["root"]), commit("head", ["root", "left", "right"], ["HEAD -> main", "main"] )];
    const folded = layout(commits);
    const summaries = folded.branches.filter((branch) => branch.mergeHash === "head");
    expect(summaries).toHaveLength(2);
    expect(folded.foldedForkEdges).toHaveLength(2);
    const opened = layout(commits, "main", ["main"], summaries.map((branch) => branch.key));
    expect(opened.parentEdges.filter((edge) => edge.childHash === "head")).toHaveLength(3);
    assertOnlyRealEdges(commits, opened);
  });
});

