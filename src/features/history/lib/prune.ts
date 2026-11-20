import { ancestry, repairRedo, type HistoryState } from "./graph";

export interface PruneOptions {
  /** Versions kept per branch, counting back from the branch head. */
  keepPerBranch?: number;
  /** Hard cap on stored commits across all branches. */
  keepTotal?: number;
}

export interface PruneReport {
  removed: number;
  truncated: number;
  kept: number;
}

/**
 * Compact old history without making any later version unrestorable.
 *
 * A commit stores a complete snapshot, so dropping an ancestor only requires
 * cutting the parent link and marking the surviving commit as truncated. That
 * surviving commit still restores perfectly on its own.
 *
 * Never pruned: branch heads, fork points, every user-named version, and (by
 * default) redo entries. Redo entries are only sacrificed, oldest first, when
 * the total budget would otherwise be exceeded; this shortens redo but never
 * removes a restorable version.
 */
export function pruneHistory(
  state: HistoryState,
  options: PruneOptions = {},
): PruneReport {
  const branches = Object.values(state.branches);
  if (!branches.length) {
    return {
      removed: 0,
      truncated: 0,
      kept: Object.keys(state.commits).length,
    };
  }

  const keepPerBranch = Math.max(2, options.keepPerBranch ?? 40);
  const keepTotal = Math.max(keepPerBranch, options.keepTotal ?? 240);

  const protectedIds = new Set<string>();
  for (const branch of branches) {
    protectedIds.add(branch.head);
    if (branch.forkedAt) protectedIds.add(branch.forkedAt);
  }
  for (const commit of Object.values(state.commits)) {
    if (commit.name) protectedIds.add(commit.id);
  }

  // Keep the most recent versions on every branch chain plus every redo entry.
  const keep = new Set<string>();
  for (const branch of branches) {
    ancestry(state, branch.head, keepPerBranch).forEach((c) => keep.add(c.id));
    branch.redo?.forEach((id) => {
      if (state.commits[id]) keep.add(id);
    });
  }
  protectedIds.forEach((id) => {
    if (state.commits[id]) keep.add(id);
  });

  // Over budget: first give up the oldest redo entries, which only shortens
  // redo. Versions reachable from a head are untouched at this stage.
  if (keep.size > keepTotal) {
    const branchReachable = new Set<string>();
    for (const branch of branches) {
      ancestry(state, branch.head).forEach((c) => branchReachable.add(c.id));
    }
    const redoOnly: string[] = [];
    const redoOwner = new Map<string, HistoryState["branches"][string]>();
    for (const branch of branches) {
      for (const id of branch.redo ?? []) {
        if (
          !branchReachable.has(id) &&
          !protectedIds.has(id) &&
          state.commits[id]
        ) {
          redoOnly.push(id);
          redoOwner.set(id, branch);
        }
      }
    }
    redoOnly.sort(
      (a, b) =>
        (state.commits[a]?.createdAt ?? 0) - (state.commits[b]?.createdAt ?? 0),
    );
    for (const id of redoOnly) {
      if (keep.size <= keepTotal) break;
      keep.delete(id);
      const owner = redoOwner.get(id);
      if (owner) owner.redo = owner.redo.filter((x) => x !== id);
    }
  }

  // Still over budget: drop the oldest unprotected versions. A version removed
  // from the middle of a chain truncates its descendants but never costs them
  // their own snapshot.
  if (keep.size > keepTotal) {
    const removable = [...keep]
      .filter((id) => !protectedIds.has(id))
      .sort(
        (a, b) =>
          (state.commits[a]?.createdAt ?? 0) -
          (state.commits[b]?.createdAt ?? 0),
      );
    for (const id of removable) {
      if (keep.size <= keepTotal) break;
      keep.delete(id);
    }
  }

  let removed = 0;
  for (const id of Object.keys(state.commits)) {
    if (!keep.has(id)) {
      delete state.commits[id];
      removed++;
    }
  }

  let truncated = 0;
  for (const commit of Object.values(state.commits)) {
    if (commit.parent && !state.commits[commit.parent]) {
      commit.parent = null;
      commit.truncated = true;
      truncated++;
    }
  }

  for (const branch of branches) {
    branch.redo = repairRedo(branch.head, branch.redo, state.commits);
    if (branch.forkedAt && !state.commits[branch.forkedAt])
      branch.forkedAt = undefined;
    if (branch.forkedFrom && !state.branches[branch.forkedFrom])
      branch.forkedFrom = undefined;
  }
  for (const [id, branch] of Object.entries(state.branches)) {
    if (!state.commits[branch.head]) delete state.branches[id];
  }
  if (!state.branches[state.currentBranch]) {
    const first = Object.keys(state.branches)[0];
    if (first) state.currentBranch = first;
  }

  return { removed, truncated, kept: Object.keys(state.commits).length };
}
