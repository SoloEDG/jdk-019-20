import type {
  HistoryBranch,
  HistoryCommit,
  HistoryPayload,
  HistorySnapshot,
} from "../../../shared/types";
import { validShape, validSnapshot } from "../../../shared/validate";
import * as g from "./graph";

export interface LoadResult {
  payload: HistoryPayload | null;
  error: string | null;
  /** True when an old single-state save was migrated into the graph format. */
  migrated: boolean;
  /** Number of entries discarded because they failed validation. */
  dropped: number;
}

function number(v: unknown, fallback: number) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Turn anything found in local storage into a normalised payload. Nothing is
 * written to the live document here, so callers can show a preview or report
 * an error and leave the workspace untouched.
 */
export function normalizePayload(raw: unknown, now = Date.now()): LoadResult {
  if (raw == null)
    return {
      payload: null,
      error: "No saved workspace found.",
      migrated: false,
      dropped: 0,
    };

  // Legacy format: a bare array of shapes.
  if (Array.isArray(raw)) {
    const shapes = raw.filter((s) => validShape(s));
    if (!shapes.length && raw.length)
      return {
        payload: null,
        error: "The saved workspace is damaged and could not be restored.",
        migrated: false,
        dropped: raw.length,
      };
    const snapshot: HistorySnapshot = {
      shapes,
      selected: [],
    };
    const root = g.createCommit(snapshot, null, "Imported saved work");
    const branch = g.createBranch("main", root.id);
    return {
      payload: {
        version: 2,
        commits: { [root.id]: root },
        branches: { [branch.id]: branch },
        currentBranch: branch.id,
        savedAt: now,
      },
      error: null,
      migrated: true,
      dropped: raw.length - shapes.length,
    };
  }

  const value = raw as Partial<HistoryPayload> & Record<string, unknown>;
  if (!value || value.version !== 2 || typeof value !== "object")
    return {
      payload: null,
      error: "The saved workspace uses an unknown format.",
      migrated: false,
      dropped: 0,
    };

  const rawCommits =
    value.commits && typeof value.commits === "object"
      ? (value.commits as Record<string, HistoryCommit>)
      : {};
  const rawBranches =
    value.branches && typeof value.branches === "object"
      ? (value.branches as Record<string, HistoryBranch>)
      : {};
  let dropped = 0;

  const commits: Record<string, HistoryCommit> = {};
  for (const [id, rawCommit] of Object.entries(rawCommits)) {
    const candidate = rawCommit as HistoryCommit | undefined;
    if (
      !candidate ||
      candidate.id !== id ||
      !validSnapshot(candidate.snapshot) ||
      (candidate.parent !== null && typeof candidate.parent !== "string")
    ) {
      dropped++;
      continue;
    }
    commits[id] = {
      id,
      parent: typeof candidate.parent === "string" ? candidate.parent : null,
      snapshot: g.sanitizeSnapshot(candidate.snapshot),
      message:
        typeof candidate.message === "string" && candidate.message
          ? candidate.message
          : "Edit",
      name:
        typeof candidate.name === "string" && candidate.name.trim()
          ? candidate.name.trim()
          : undefined,
      createdAt: number(candidate.createdAt, 0),
      truncated: !!candidate.truncated,
      key: typeof candidate.key === "string" ? candidate.key : undefined,
    };
  }
  for (const commit of Object.values(commits)) {
    if (commit.parent && !commits[commit.parent]) {
      commit.parent = null;
      commit.truncated = true;
      dropped++;
    }
  }

  const branches: Record<string, HistoryBranch> = {};
  for (const [id, rawBranch] of Object.entries(rawBranches)) {
    const candidate = rawBranch as HistoryBranch | undefined;
    if (!candidate || candidate.id !== id || !commits[candidate.head]) {
      dropped++;
      continue;
    }
    branches[id] = {
      id,
      name:
        typeof candidate.name === "string" && candidate.name.trim()
          ? candidate.name.trim()
          : "Branch",
      head: candidate.head,
      redo: g.repairRedo(candidate.head, candidate.redo, commits),
      selection: Array.isArray(candidate.selection)
        ? candidate.selection.filter((x) => typeof x === "string")
        : undefined,
      createdAt: number(candidate.createdAt, 0),
      updatedAt: number(candidate.updatedAt, 0),
      forkedFrom:
        typeof candidate.forkedFrom === "string" &&
        rawBranches[candidate.forkedFrom]
          ? candidate.forkedFrom
          : undefined,
      forkedAt:
        typeof candidate.forkedAt === "string" && commits[candidate.forkedAt]
          ? candidate.forkedAt
          : undefined,
    };
  }
  const ids = Object.keys(branches);
  if (!ids.length)
    return {
      payload: null,
      error: "The saved workspace has no restorable branch.",
      migrated: false,
      dropped,
    };

  // A version 2 payload must name a branch that still exists; anything else
  // indicates corruption, and silently switching branches would surprise the
  // user by replacing their current work with a different state.
  const currentBranch =
    typeof value.currentBranch === "string" && branches[value.currentBranch]
      ? value.currentBranch
      : null;
  if (!currentBranch)
    return {
      payload: null,
      error: "The saved workspace's checked out branch is missing.",
      migrated: false,
      dropped,
    };
  const draft =
    value.draft && validSnapshot(value.draft)
      ? g.sanitizeSnapshot(value.draft)
      : undefined;

  return {
    payload: {
      version: 2,
      commits,
      branches,
      currentBranch,
      savedAt: number(value.savedAt, now),
      draft,
    },
    error: null,
    migrated: false,
    dropped,
  };
}
