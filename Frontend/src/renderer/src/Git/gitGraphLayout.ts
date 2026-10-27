import type { GitCommit } from "../../../shared/ipc-types";

export type GraphSpacing = "compact" | "roomy";

export interface GraphGroup {
  commits: GitCommit[];
  lane: number;
  row: number;
}

export interface GraphPoint {
  x: number;
  y: number;
  lane: number;
  row: number;
}

export interface GraphBranch {
  key: string;
  name: string;
  hashes: string[];
  forkHash: string | null;
  tipHash: string;
  mergeHash: string | null;
  lane: number;
  row: number;
  insertions: number;
  deletions: number;
  groupIndex: number;
  parentKey: string | null;
}

export interface GraphParentEdge {
  parentHash: string;
  childHash: string;
  fromGroup: number;
  toGroup: number;
}

export function commitChangeTotals(commit: GitCommit): { insertions: number; deletions: number } {
  // Per-file numstat is the source used to render the file list. Deriving the
  // card total from the same records prevents summary and file counts drifting.
  if (commit.fileChanges?.length) return commit.fileChanges.reduce((total, file) => {
    if (!file.binary) {
      total.insertions += file.insertions ?? 0;
      total.deletions += file.deletions ?? 0;
    }
    return total;
  }, { insertions: 0, deletions: 0 });
  return { insertions: commit.insertions ?? 0, deletions: commit.deletions ?? 0 };
}

export interface GitGraphLayout {
  grouped: GraphGroup[];
  groupForHash: Map<string, number>;
  positions: Map<number, GraphPoint>;
  branchPositions: Map<string, GraphPoint>;
  branches: GraphBranch[];
  visibleGroups: number[];
  visibleBranches: GraphBranch[];
  parentEdges: GraphParentEdge[];
  foldedForkEdges: Array<{ branchKey: string; fromGroup: number }>;
  foldedMergeEdges: Array<{ branchKey: string; toGroup: number }>;
  branchParents: Map<string, string>;
  branchOwners: Map<string, string>;
  cardWidth: number;
  branchCardWidth: number;
  cardHeights: Map<number, number>;
  groupHeights: Map<number, number>;
  rowGapRoutes: Map<number, number>;
  width: number;
  height: number;
}

interface BuildOptions {
  currentBranch: string;
  branchNames: string[];
  openBranches: ReadonlySet<string>;
  expandedGroups: ReadonlySet<string>;
  spacing: GraphSpacing;
}

interface BranchSeed {
  key: string;
  name: string;
  hashes: string[];
  forkHash: string | null;
  tipHash: string;
  mergeHash: string | null;
  lane: number;
}

function branchLabel(commit: GitCommit | undefined): string | undefined {
  return commit?.refs
    .map((ref) => ref.startsWith("HEAD -> ") ? ref.slice(8) : ref)
    .find((ref) => ref && !ref.startsWith("tag: ") && !ref.includes(" -> "));
}

function firstParentAncestors(start: string | undefined, commits: Map<string, GitCommit>): Set<string> {
  const hashes = new Set<string>();
  let hash = start;
  while (hash && !hashes.has(hash)) {
    hashes.add(hash);
    hash = commits.get(hash)?.parents[0];
  }
  return hashes;
}

export function buildGitGraphLayout(commits: GitCommit[], options: BuildOptions): GitGraphLayout {
  const commitByHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const heads = new Map<string, string>();
  for (const commit of commits) for (const rawRef of commit.refs) {
    const ref = rawRef.startsWith("HEAD -> ") ? rawRef.slice(8) : rawRef;
    if (ref && !ref.startsWith("tag: ") && !ref.includes(" -> ")) heads.set(ref, commit.hash);
  }

  const preferredBranch = heads.has(options.currentBranch)
    ? options.currentBranch
    : ["main", "master"].find((branch) => heads.has(branch))
      ?? [...new Set([...options.branchNames, ...heads.keys()])].filter((branch) => heads.has(branch)).sort()[0]
      ?? [...heads.keys()].sort()[0];
  const orderedHeads = [preferredBranch, ...options.branchNames.slice().sort(), ...[...heads.keys()].sort()]
    .filter((branch, index, all): branch is string => !!branch && all.indexOf(branch) === index && heads.has(branch));

  // Each named head claims its first-parent run until it joins an existing lane.
  // The selected branch (or fallback head) claims lane zero.
  const commitLanes = new Map<string, number>();
  let nextLane = 0;
  for (const branch of orderedHeads) {
    const head = heads.get(branch);
    if (!head || commitLanes.has(head)) continue;
    const lane = branch === preferredBranch ? 0 : ++nextLane;
    let hash: string | undefined = head;
    const seen = new Set<string>();
    while (hash && !seen.has(hash) && !commitLanes.has(hash)) {
      seen.add(hash);
      commitLanes.set(hash, lane);
      hash = commitByHash.get(hash)?.parents[0];
    }
  }
  // Recover lanes for commits whose branch ref was deleted, using every
  // secondary merge parent (including octopus merges).
  for (const commit of commits) for (const parent of commit.parents.slice(1)) {
    if (commitLanes.has(parent)) continue;
    const lane = ++nextLane;
    let hash: string | undefined = parent;
    const seen = new Set<string>();
    while (hash && !seen.has(hash) && !commitLanes.has(hash)) {
      seen.add(hash);
      commitLanes.set(hash, lane);
      hash = commitByHash.get(hash)?.parents[0];
    }
  }
  for (const commit of commits) if (!commitLanes.has(commit.hash)) {
    const parentLane = commit.parents.map((parent) => commitLanes.get(parent)).find((lane) => lane !== undefined);
    commitLanes.set(commit.hash, parentLane ?? 0);
  }

  const children = new Map<string, string[]>();
  for (const commit of commits) for (const parent of commit.parents) children.set(parent, [...(children.get(parent) ?? []), commit.hash]);
  const headAncestors = new Map([...heads].map(([name, hash]) => [name, firstParentAncestors(hash, commitByHash)]));
  const branchSeeds: BranchSeed[] = [];

  // A merge can have any number of secondary parents. Each secondary history
  // becomes its own foldable branch, ending at the merge's first-parent base.
  for (const merge of commits) if (merge.parents.length > 1) {
    const baseAncestors = firstParentAncestors(merge.parents[0], commitByHash);
    for (let parentIndex = 1; parentIndex < merge.parents.length; parentIndex += 1) {
      const tipHash = merge.parents[parentIndex];
      const hashes: string[] = [];
      let cursor: string | undefined = tipHash;
      const seen = new Set<string>();
      while (cursor && !baseAncestors.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor);
        hashes.push(cursor);
        cursor = commitByHash.get(cursor)?.parents[0];
      }
      if (!hashes.length) continue;
      const namedHead = [...heads.keys()].sort().find((name) => {
        const head = heads.get(name);
        return !!head && (hashes.includes(head) || head === tipHash);
      });
      const sourceName = branchLabel(commitByHash.get(tipHash));
      branchSeeds.push({
        key: `merge:${merge.hash}:${parentIndex}`,
        name: namedHead ?? sourceName ?? `Merged branch ${parentIndex}`,
        hashes,
        forkHash: cursor ?? null,
        tipHash,
        mergeHash: merge.hash,
        lane: commitLanes.get(tipHash) ?? parentIndex
      });
    }
  }

  // Keep visible unmerged refs foldable as well. If a named branch is already
  // represented by a merge summary, do not create a duplicate branch card.
  const trunkHead = preferredBranch ? heads.get(preferredBranch) : undefined;
  const trunkAncestors = firstParentAncestors(trunkHead, commitByHash);
  for (const name of orderedHeads) {
    const head = heads.get(name);
    if (!head || trunkAncestors.has(head)) continue;
    if (branchSeeds.some((branch) => branch.hashes.includes(head) || branch.tipHash === head)) continue;
    const hashes: string[] = [];
    let cursor: string | undefined = head;
    const seen = new Set<string>();
    while (cursor && !trunkAncestors.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      hashes.push(cursor);
      cursor = commitByHash.get(cursor)?.parents[0];
    }
    if (!hashes.length) continue;
    branchSeeds.push({ key: `ref:${name}:${head}`, name, hashes, forkHash: cursor ?? null, tipHash: head, mergeHash: null, lane: commitLanes.get(head) ?? 0 });
  }

  // Fold the smallest branch segment owning each commit. This makes a nested
  // branch's own card take precedence while its containing branch is open.
  const branchParents = new Map<string, string>();
  for (const branch of branchSeeds) {
    const containers = branchSeeds
      .filter((candidate) => candidate.key !== branch.key && (
        (!!branch.mergeHash && candidate.hashes.includes(branch.mergeHash)) ||
        (!!branch.forkHash && candidate.hashes.includes(branch.forkHash))
      ))
      .sort((a, b) => a.hashes.length - b.hashes.length);
    if (containers[0]) branchParents.set(branch.key, containers[0].key);
  }
  const branchOwners = new Map<string, string>();
  for (const branch of branchSeeds) for (const hash of branch.hashes) {
    const current = branchOwners.get(hash);
    if (!current || (branchSeeds.find((candidate) => candidate.key === current)?.hashes.length ?? Infinity) > branch.hashes.length) branchOwners.set(hash, branch.key);
  }
  const branchIsOpen = (key: string, seen = new Set<string>()): boolean => {
    if (seen.has(key) || !options.openBranches.has(key)) return false;
    seen.add(key);
    const parent = branchParents.get(key);
    return !parent || branchIsOpen(parent, seen);
  };

  // Group only true linear runs. Forks, merges, refs, and branch ownership
  // boundaries always remain explicit graph nodes.
  const branchBoundary = new Set<string>();
  for (const branch of branchSeeds) {
    if (branch.forkHash) branchBoundary.add(branch.forkHash);
    if (branch.mergeHash) branchBoundary.add(branch.mergeHash);
  }
  const grouped: GraphGroup[] = [];
  const groupForHash = new Map<string, number>();
  for (const commit of commits) {
    if (groupForHash.has(commit.hash)) continue;
    const group = [commit];
    groupForHash.set(commit.hash, grouped.length);
    let tail = commit;
    while (
      tail.parents.length <= 1 &&
      tail.refs.length === 0 &&
      !branchBoundary.has(tail.hash) &&
      (children.get(tail.hash)?.length ?? 0) === 1
    ) {
      const next = commitByHash.get(children.get(tail.hash)![0]);
      if (!next || next.parents.length !== 1 || next.refs.length || branchBoundary.has(next.hash) || commitLanes.get(next.hash) !== commitLanes.get(tail.hash)) break;
      group.push(next);
      groupForHash.set(next.hash, grouped.length);
      tail = next;
    }
    grouped.push({ commits: group, lane: commitLanes.get(commit.hash) ?? 0, row: 0 });
  }

  // Compute levels and lane occupancy from parent edges only.
  const commitRows = new Map<string, number>();
  const occupiedByLane = new Map<number, Set<number>>();
  for (const commit of commits) {
    const lane = commitLanes.get(commit.hash) ?? 0;
    // The first parent defines the vertical lane's continuation. Secondary
    // merge parents are real links, but must not push the trunk down to the
    // side branch's row; that creates large empty gaps in the main history.
    const parentRows = commit.parents
      .slice(0, 1)
      .map((parent) => commitRows.get(parent))
      .filter((row): row is number => row !== undefined);
    const minRow = parentRows.length ? Math.max(...parentRows) + 1 : 0;
    const occupied = occupiedByLane.get(lane) ?? new Set<number>();
    let row = minRow;
    while (occupied.has(row)) row += 1;
    occupied.add(row);
    occupiedByLane.set(lane, occupied);
    commitRows.set(commit.hash, row);
  }
  for (const group of grouped) group.row = commitRows.get(group.commits[group.commits.length - 1].hash) ?? 0;
  const firstVisibleRow = grouped.length ? Math.min(...grouped.map((group) => group.row)) : 0;
  for (const group of grouped) group.row -= firstVisibleRow;

  const visibleGroups = grouped.map((_, index) => index).filter((index) => {
    const owners = new Set(grouped[index].commits.map((commit) => branchOwners.get(commit.hash)).filter((key): key is string => !!key));
    return [...owners].every((owner) => branchIsOpen(owner));
  });
  const visibleSet = new Set(visibleGroups);
  const laneValues = [...new Set(grouped.map((group) => group.lane))].sort((a, b) => a - b);
  const laneOrder = new Map(laneValues.map((lane, index) => [lane, index]));
  const cardWidth = 480;
  const branchCardWidth = 264;
  const laneGap = 640;
  const cardHeight = 160;
  const branchCardHeight = 168;
  const rowGap = options.spacing === "compact" ? 176 : 208;
  const groupHeights = new Map<number, number>();
  for (let index = 0; index < grouped.length; index += 1) {
    const group = grouped[index].commits;
    const expandedHeight = options.expandedGroups.has(group[0].hash) ? group.length * 36 + 24 : 0;
    groupHeights.set(index, cardHeight + expandedHeight);
  }
  const groupRows = new Map<number, number>();
  const rowHeights = new Map<number, number>();
  for (const index of visibleGroups) {
    const row = grouped[index].row;
    groupRows.set(index, row);
    rowHeights.set(row, Math.max(rowHeights.get(row) ?? 0, groupHeights.get(index) ?? cardHeight, rowGap));
  }

  const branchParentKeyFor = (branch: BranchSeed): string | null => branchParents.get(branch.key) ?? null;
  const occupiedSummaryRows = new Map<number, Set<number>>();
  for (const index of visibleGroups) {
    const group = grouped[index];
    const occupied = occupiedSummaryRows.get(group.lane) ?? new Set<number>();
    occupied.add(groupRows.get(index) ?? 0);
    occupiedSummaryRows.set(group.lane, occupied);
  }
  const visibleBranches: GraphBranch[] = branchSeeds
    .filter((branch) => !branchParents.has(branch.key) || branchIsOpen(branchParents.get(branch.key)!))
    .map((branch) => {
      const firstHash = branch.hashes[branch.hashes.length - 1];
      const groupIndex = groupForHash.get(firstHash) ?? groupForHash.get(branch.tipHash) ?? -1;
      const forkGroup = branch.forkHash ? groupForHash.get(branch.forkHash) : undefined;
      let row = forkGroup === undefined ? Math.max(0, (groupRows.get(groupIndex) ?? 0) - 1) : groupRows.get(forkGroup) ?? 0;
      const occupied = occupiedSummaryRows.get(branch.lane) ?? new Set<number>();
      while (occupied.has(row)) row += 1;
      occupied.add(row);
      occupiedSummaryRows.set(branch.lane, occupied);
      rowHeights.set(row, Math.max(rowHeights.get(row) ?? rowGap, branchCardHeight + 16));
      const branchStats = branch.hashes.reduce((totals, hash) => {
        const commit = commitByHash.get(hash);
        if (commit) {
          const changes = commitChangeTotals(commit);
          totals.insertions += changes.insertions;
          totals.deletions += changes.deletions;
        }
        return totals;
      }, { insertions: 0, deletions: 0 });
      return { ...branch, ...branchStats, groupIndex, row, parentKey: branchParentKeyFor(branch) };
    });

  const rowTops = new Map<number, number>();
  let graphHeight = 40;
  // Only rows containing visible cards consume vertical space. Hidden branch
  // commits can leave gaps in the topological row numbers; preserving those
  // empty rows creates long, unexplained trunk connectors.
  for (const row of [...rowHeights.keys()].sort((a, b) => a - b)) {
    rowTops.set(row, graphHeight);
    graphHeight += (rowHeights.get(row) ?? rowGap) + 20;
  }
  const rowGapRoutes = new Map([...rowHeights].map(([row, height]) => [row, (rowTops.get(row) ?? 40) + height + 8]));
  const positions = new Map<number, GraphPoint>();
  for (const index of visibleGroups) {
    const group = grouped[index];
    const order = laneOrder.get(group.lane) ?? 0;
    const row = group.row;
    positions.set(index, { x: 24 + order * laneGap + cardWidth / 2, y: (rowTops.get(row) ?? 40) + cardHeight / 2, lane: order, row });
  }
  const branchPositions = new Map<string, GraphPoint>();
  for (const branch of visibleBranches) {
    const order = laneOrder.get(branch.lane) ?? 0;
    branchPositions.set(branch.key, { x: 24 + order * laneGap + cardWidth / 2, y: (rowTops.get(branch.row) ?? 40) + branchCardHeight / 2, lane: order, row: branch.row });
  }

  const parentEdges: GraphParentEdge[] = [];
  for (const child of commits) for (const parentHash of child.parents) {
    const fromGroup = groupForHash.get(parentHash);
    const toGroup = groupForHash.get(child.hash);
    if (fromGroup === undefined || toGroup === undefined || fromGroup === toGroup || !visibleSet.has(fromGroup) || !visibleSet.has(toGroup)) continue;
    parentEdges.push({ parentHash, childHash: child.hash, fromGroup, toGroup });
  }
  const foldedMergeEdges = visibleBranches
    .filter((branch) => !!branch.mergeHash && !branchIsOpen(branch.key))
    .map((branch) => ({ branchKey: branch.key, toGroup: groupForHash.get(branch.mergeHash!) }))
    .filter((edge): edge is { branchKey: string; toGroup: number } => edge.toGroup !== undefined && visibleSet.has(edge.toGroup));
  const foldedForkEdges = visibleBranches
    .filter((branch) => !!branch.forkHash && !branchIsOpen(branch.key))
    .map((branch) => ({ branchKey: branch.key, fromGroup: groupForHash.get(branch.forkHash!) }))
    .filter((edge): edge is { branchKey: string; fromGroup: number } => edge.fromGroup !== undefined && visibleSet.has(edge.fromGroup));

  return {
    grouped,
    groupForHash,
    positions,
    branchPositions,
    branches: branchSeeds.map((branch) => {
      const totals = branch.hashes.reduce((sum, hash) => {
        const commit = commitByHash.get(hash);
        if (commit) {
          const changes = commitChangeTotals(commit);
          sum.insertions += changes.insertions;
          sum.deletions += changes.deletions;
        }
        return sum;
      }, { insertions: 0, deletions: 0 });
      return { ...branch, ...totals, groupIndex: groupForHash.get(branch.tipHash) ?? -1, row: 0, parentKey: branchParentKeyFor(branch) };
    }),
    visibleGroups,
    visibleBranches,
    parentEdges,
    foldedForkEdges,
    foldedMergeEdges,
    branchParents,
    branchOwners,
    cardWidth,
    branchCardWidth,
    cardHeights: new Map(visibleGroups.map((index) => [index, cardHeight])),
    groupHeights: new Map(visibleGroups.map((index) => [index, groupHeights.get(index) ?? cardHeight])),
    rowGapRoutes,
    width: Math.max(350, (laneValues.length || 1) * laneGap + 24),
    height: Math.max(260, graphHeight + 24)
  };
}
