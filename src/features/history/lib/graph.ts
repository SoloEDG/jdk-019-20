import type {
  HistoryBranch,
  HistoryCommit,
  HistoryPayload,
  HistorySnapshot,
  Shape,
} from "../../../shared/types";

/**
 * Pure history graph operations. Nothing in here touches Vue state or
 * localStorage, which keeps branching/undo/redo rules easy to reason about.
 *
 * Invariants:
 * - a commit is immutable and always carries a complete snapshot;
 * - a branch head is always restorable even when older ancestry was pruned;
 * - a branch keeps its own redo stack, so switching branches never loses the
 *   operations that were undone on the other branch.
 */

export function newId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

/** Drop selection ids that no longer exist in the snapshot. */
export function sanitizeSnapshot(s: HistorySnapshot): HistorySnapshot {
  const ids = new Set(s.shapes.map((x) => x.id));
  return {
    shapes: JSON.parse(JSON.stringify(s.shapes)) as Shape[],
    selected: s.selected.filter((id) => ids.has(id)),
  };
}

export interface HistoryState {
  commits: Record<string, HistoryCommit>;
  branches: Record<string, HistoryBranch>;
  currentBranch: string;
}

export function createState(): HistoryState {
  return { commits: {}, branches: {}, currentBranch: "" };
}

export function createCommit(
  snapshot: HistorySnapshot,
  parent: string | null,
  message: string,
  name?: string,
): HistoryCommit {
  return {
    id: newId(),
    parent,
    snapshot: sanitizeSnapshot(snapshot),
    message,
    name: name?.trim() || undefined,
    createdAt: Date.now(),
  };
}

export function createBranch(
  name: string,
  head: string,
  extras: Partial<HistoryBranch> = {},
): HistoryBranch {
  const now = Date.now();
  return {
    id: newId(),
    name: name.trim() || "Branch",
    head,
    redo: [],
    createdAt: now,
    updatedAt: now,
    ...extras,
  };
}

export function uniqueBranchName(
  branches: Record<string, HistoryBranch>,
  base: string,
) {
  const taken = new Set(
    Object.values(branches).map((b) => b.name.toLowerCase()),
  );
  const candidate = base.trim() || "Branch";
  if (!taken.has(candidate.toLowerCase())) return candidate;
  for (let i = 2; ; i++) {
    const next = `${candidate} ${i}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
}

/** Walk from a branch head towards the root, following parent links. */
export function ancestry(
  state: HistoryState,
  head: string | null | undefined,
  limit = Infinity,
): HistoryCommit[] {
  const out: HistoryCommit[] = [];
  const seen = new Set<string>();
  let id = head ?? null;
  while (id && !seen.has(id) && out.length < limit) {
    const commit = state.commits[id];
    if (!commit) break;
    seen.add(id);
    out.push(commit);
    id = commit.parent;
  }
  return out;
}

/**
 * Every commit reachable from any branch head. Used by storage maintenance so
 * that a version referenced by another branch is never garbage collected.
 */
export function reachableCommits(state: HistoryState) {
  const reachable = new Set<string>();
  for (const branch of Object.values(state.branches)) {
    for (const id of [branch.head, ...branch.redo]) {
      if (state.commits[id]) reachable.add(id);
    }
    ancestry(state, branch.head).forEach((c) => reachable.add(c.id));
  }
  return reachable;
}

/**
 * Keep only redo entries whose parent link still matches the chain leading
 * away from the branch head. Broken links (e.g. after pruning) are dropped so
 * redo can never jump to an unrelated version.
 */
export function repairRedo(
  head: string,
  redo: unknown,
  commits: Record<string, HistoryCommit>,
) {
  if (!Array.isArray(redo)) return [];
  const keep: string[] = [];
  let cursor = head;
  for (let i = redo.length - 1; i >= 0; i--) {
    const id = redo[i];
    const commit = typeof id === "string" ? commits[id] : undefined;
    if (typeof id === "string" && commit && commit.parent === cursor) {
      keep.unshift(id);
      cursor = id;
    } else break;
  }
  return keep;
}

export function serializePayload(
  state: HistoryState,
  savedAt: number,
  draft?: HistorySnapshot,
): HistoryPayload {
  const payload: HistoryPayload = {
    version: 2,
    commits: state.commits,
    branches: state.branches,
    currentBranch: state.currentBranch,
    savedAt,
  };
  if (draft) payload.draft = draft;
  return payload;
}
