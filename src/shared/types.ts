export interface Point {
  x: number;
  y: number;
}
export interface Node extends Point {
  in: Point;
  out: Point;
}
export interface Shape {
  id: string;
  name: string;
  nodes: Node[];
  closed: boolean;
  fill: string;
  stroke: string;
  width: number;
  opacity: number;
  group?: string;
}
export interface Document {
  shapes: Shape[];
  selected: string[];
  tool: string;
  zoom: number;
}

/** A complete, self-contained state that can be restored on its own. */
export interface HistorySnapshot {
  shapes: Shape[];
  selected: string[];
}

/**
 * An immutable version in the history graph. Every commit stores a full
 * snapshot, so even if its ancestry is later compacted away the version
 * itself can still be restored.
 */
export interface HistoryCommit {
  id: string;
  parent: string | null;
  snapshot: HistorySnapshot;
  message: string;
  /** User supplied checkpoint name. Named versions are never auto-pruned. */
  name?: string;
  createdAt: number;
  /** True when older ancestry was compacted away by storage maintenance. */
  truncated?: boolean;
  /** Groups rapid edits (e.g. a slider drag) into one commit. */
  key?: string;
}

export interface HistoryBranch {
  id: string;
  name: string;
  head: string;
  /** Commits that were undone and can be redone on this branch. */
  redo: string[];
  /** Last selection on this branch, restored when checking it out again. */
  selection?: string[];
  createdAt: number;
  updatedAt: number;
  /** Branch this one was forked from, used to show branch relationships. */
  forkedFrom?: string;
  /** Commit at which this branch was forked. */
  forkedAt?: string;
}

export interface HistoryPayload {
  version: 2;
  commits: Record<string, HistoryCommit>;
  branches: Record<string, HistoryBranch>;
  currentBranch: string;
  savedAt: number;
  /** Working state that has not been committed yet. */
  draft?: HistorySnapshot;
}
