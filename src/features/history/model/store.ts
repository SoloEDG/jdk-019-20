import { computed, ref } from "vue";
import { doc } from "../../../shared/document";
import type {
  HistoryBranch,
  HistoryCommit,
  HistoryPayload,
  HistorySnapshot,
  Shape,
} from "../../../shared/types";
import { validSnapshot } from "../../../shared/validate";
import { compare, type Comparison } from "../lib/compare";
import * as g from "../lib/graph";

/**
 * The single source of truth for version history.
 *
 * The document is modelled as a DAG of complete snapshots ("commits"). Each
 * branch points at one commit and keeps its own redo stack, so switching
 * branches can never lose operations that were undone elsewhere. Every commit
 * stores the whole document, which means a version stays restorable even after
 * its older ancestry has been pruned from storage.
 */

const state = g.createState();

/** Bumped whenever the graph changes so panels and autosave can react. */
export const historyTick = ref(0);
/** Bumped whenever the document content is replaced by a history operation. */
export const revision = ref(0);

/** Consecutive coalescing edits within this window fold into one version. */
const COALESCE_MS = 1500;
/** Idle delay after which a settling (e.g. slider) gesture becomes a version. */
const SETTLE_MS = 900;

interface Gesture {
  snapshot: HistorySnapshot;
  key: string;
  coalesce: boolean;
  message: string;
  timer?: ReturnType<typeof setTimeout>;
}

let gesture: Gesture | null = null;

function touch() {
  historyTick.value++;
}

/**
 * Read the graph revision so any render or computed that calls a query below
 * becomes reactive to history changes (the graph itself stays plain data).
 */
function dep() {
  void historyTick.value;
}

export function snapshotOf(): HistorySnapshot {
  const shapes = JSON.parse(JSON.stringify(doc.shapes)) as Shape[];
  const ids = new Set(shapes.map((s) => s.id));
  return { shapes, selected: doc.selected.filter((id) => ids.has(id)) };
}

/** Replace the document with a snapshot, dropping dangling selection ids. */
function hydrate(snapshot: HistorySnapshot) {
  const next = g.sanitizeSnapshot(snapshot);
  doc.shapes = next.shapes;
  doc.selected = next.selected;
  revision.value++;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function isReady() {
  dep();
  return !!state.branches[state.currentBranch];
}

export function branchList(): HistoryBranch[] {
  dep();
  return Object.values(state.branches).sort(
    (a, b) => a.createdAt - b.createdAt,
  );
}

export function currentBranch(): HistoryBranch | undefined {
  dep();
  return state.branches[state.currentBranch];
}

export function currentCommit(): HistoryCommit | undefined {
  const branch = currentBranch();
  return branch ? state.commits[branch.head] : undefined;
}

export function commitById(id: string): HistoryCommit | undefined {
  dep();
  return state.commits[id];
}

export function branchHistory(id: string): HistoryCommit[] {
  dep();
  const branch = state.branches[id];
  return branch ? g.ancestry(state, branch.head) : [];
}

export function branchParent(id: string): HistoryBranch | undefined {
  dep();
  const branch = state.branches[id];
  return branch?.forkedFrom ? state.branches[branch.forkedFrom] : undefined;
}

/**
 * Every commit that carries a user supplied name, across all branches. Named
 * versions are protected from pruning, so a name can outlive the branch chain
 * it used to sit on; such a version is still listed and can be restored (as a
 * new version on the current branch) even when it is no longer an ancestor of
 * any head.
 */
export function namedCommits(): Array<{
  commit: HistoryCommit;
  branch: HistoryBranch | undefined;
}> {
  dep();
  const owner = new Map<string, HistoryBranch>();
  for (const branch of branchList()) {
    for (const commit of g.ancestry(state, branch.head)) {
      if (!owner.has(commit.id)) owner.set(commit.id, branch);
    }
  }
  return Object.values(state.commits)
    .filter((commit) => !!commit.name)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((commit) => ({ commit, branch: owner.get(commit.id) }));
}

export function isCommitOnCurrentBranch(id: string) {
  dep();
  return g.ancestry(state, currentBranch()?.head).some((c) => c.id === id);
}

/**
 * What exports read: the checked out branch's head commit. It is deliberately
 * not the live editing buffer, so a half-finished gesture, a restore preview
 * or an alternative branch can never leak into an exported file.
 */
export const confirmedSnapshot = computed<HistorySnapshot>(() => {
  dep();
  const commit = currentCommit();
  return commit
    ? g.sanitizeSnapshot(commit.snapshot)
    : { shapes: [], selected: [] };
});

/**
 * Commit any pending gesture to the current branch, then return the confirmed
 * head. Exports must never read a previewed branch or the live buffer.
 */
export function exportSnapshot(): HistorySnapshot {
  commitPending();
  return confirmedSnapshot.value;
}

// ---------------------------------------------------------------------------
// Bootstrapping
// ---------------------------------------------------------------------------

export function initHistory(snapshot: HistorySnapshot = snapshotOf()) {
  if (isReady()) return;
  const snap = g.sanitizeSnapshot(snapshot);
  const root = g.createCommit(snap, null, "Initial version");
  const main = g.createBranch("main", root.id);
  state.commits[root.id] = root;
  state.branches[main.id] = main;
  state.currentBranch = main.id;
  touch();
}

function isShared(commitId: string) {
  for (const branch of Object.values(state.branches)) {
    if (branch.head === commitId && branch.id !== state.currentBranch)
      return true;
    if (branch.redo.includes(commitId)) return true;
    if (branch.forkedAt === commitId) return true;
  }
  return Object.values(state.commits).some(
    (commit) => commit.parent === commitId,
  );
}

/**
 * Preserve operations that were undone before a new edit. Instead of dropping
 * them, the furthest undone version becomes the head of a new branch. Parent
 * links keep the whole chain reachable and restorable.
 */
function preserveFuture(branch: HistoryBranch) {
  const redo = branch.redo.filter((id) => state.commits[id]);
  branch.redo = [];
  if (!redo.length) return;
  const furthest = state.commits[redo[0]];
  if (!furthest) return;
  const name = g.uniqueBranchName(state.branches, `${branch.name} (undone)`);
  const alternative = g.createBranch(name, furthest.id, {
    forkedFrom: branch.id,
    forkedAt: branch.head,
    selection: branch.selection ? [...branch.selection] : undefined,
  });
  state.branches[alternative.id] = alternative;
  touch();
}

function clearGestureTimer() {
  if (gesture?.timer) clearTimeout(gesture.timer);
  if (gesture) gesture.timer = undefined;
}

function commitGesture(messageOverride?: string) {
  if (!gesture) return;
  const current = gesture;
  gesture = null;
  if (current.timer) clearTimeout(current.timer);
  if (!isReady()) initHistory(current.snapshot);
  const branch = currentBranch();
  if (!branch) return;

  const next = g.sanitizeSnapshot(snapshotOf());
  const previous = state.commits[branch.head];
  const message = (messageOverride || current.message || "Edit").trim();

  if (!previous) {
    const commit = g.createCommit(next, null, message);
    state.commits[commit.id] = commit;
    branch.head = commit.id;
    branch.updatedAt = Date.now();
    branch.selection = [...next.selected];
    touch();
    return;
  }

  // Geometry, appearance and stacking order are all compared. A dragged but
  // unchanged document must not create a phantom version, no matter how many
  // pointermove events it produced.
  if (compare(previous.snapshot.shapes, next.shapes).same) {
    branch.selection = [...next.selected];
    touch();
    return;
  }

  if (branch.redo.length) preserveFuture(branch);

  const now = Date.now();
  const amendable =
    current.coalesce &&
    !previous.name &&
    !previous.truncated &&
    previous.key === current.key &&
    !isShared(previous.id) &&
    now - previous.createdAt < COALESCE_MS;

  if (amendable) {
    // Still a complete snapshot: only the bounded undo granularity changes.
    previous.snapshot = next;
    previous.createdAt = now;
    previous.message = message;
  } else {
    const commit = g.createCommit(next, branch.head, message);
    if (current.coalesce) commit.key = current.key;
    state.commits[commit.id] = commit;
    branch.head = commit.id;
  }
  branch.redo = [];
  branch.updatedAt = now;
  branch.selection = [...next.selected];
  touch();
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

export interface BeginOptions {
  message?: string;
  /**
   * Fold repeated edits with the same key into one version and settle after a
   * short idle pause (sliders, colour pickers, number inputs). Each version
   * still stores a complete snapshot.
   */
  coalesce?: boolean;
}

function armSettleTimer(key: string) {
  if (!gesture || !gesture.coalesce) return;
  if (gesture.timer) clearTimeout(gesture.timer);
  gesture.timer = setTimeout(() => {
    if (gesture?.key === key) commitGesture();
  }, SETTLE_MS);
}

/**
 * Start or continue a gesture.
 *
 * Pointer interactions (dragging shapes, pen strokes) call `beginEdit` once on
 * pointerdown and `endEdit` once on pointerup, so any number of pointermove
 * events collapse into a single version. Coalescing gestures instead settle on
 * their own after the user stops editing.
 */
export function beginEdit(key = "edit", options: BeginOptions = {}) {
  if (gesture && gesture.key === key) {
    gesture.message = options.message || gesture.message;
    gesture.coalesce ||= !!options.coalesce;
    armSettleTimer(key);
    return;
  }
  if (gesture) commitGesture();
  if (!isReady()) initHistory(snapshotOf());
  gesture = {
    snapshot: snapshotOf(),
    key,
    coalesce: !!options.coalesce,
    message: options.message || "Edit",
  };
  armSettleTimer(key);
}

export function endEdit(key?: string, message?: string) {
  if (!gesture) return;
  if (key && gesture.key !== key) return;
  commitGesture(message);
}

export function commitPending(message?: string) {
  if (gesture) commitGesture(message);
}

/** Forget an in-progress gesture without writing a version. */
export function cancelEdit() {
  clearGestureTimer();
  gesture = null;
}

export function hasPendingEdit() {
  return !!gesture;
}

/** Remember the live selection on the branch without creating a version. */
export function syncSelection() {
  const branch = currentBranch();
  if (!branch) return;
  const ids = new Set(doc.shapes.map((s) => s.id));
  branch.selection = doc.selected.filter((id) => ids.has(id));
}

export function canUndo() {
  if (gesture) return true;
  const commit = currentCommit();
  return !!commit?.parent;
}

export function canRedo() {
  return !!currentBranch()?.redo.length;
}

export function undo() {
  if (gesture) {
    // Undo while an edit is still in flight cancels that edit instead of
    // consuming an older version.
    const snapshot = gesture.snapshot;
    cancelEdit();
    hydrate(snapshot);
    syncSelection();
    touch();
    return;
  }
  const branch = currentBranch();
  if (!branch) return;
  const head = state.commits[branch.head];
  if (!head?.parent) return;
  const parent = state.commits[head.parent];
  if (!parent) return;
  branch.redo.push(branch.head);
  branch.head = head.parent;
  branch.updatedAt = Date.now();
  hydrate(parent.snapshot);
  branch.selection = [...doc.selected];
  touch();
}

export function redo() {
  commitPending();
  const branch = currentBranch();
  if (!branch) return;
  while (branch.redo.length) {
    const id = branch.redo[branch.redo.length - 1];
    const commit = state.commits[id];
    if (!commit) {
      branch.redo.pop();
      continue;
    }
    branch.redo.pop();
    branch.head = id;
    branch.updatedAt = Date.now();
    hydrate(commit.snapshot);
    branch.selection = [...doc.selected];
    touch();
    return;
  }
}

// ---------------------------------------------------------------------------
// Naming and branching
// ---------------------------------------------------------------------------

export function renameBranch(branchId: string, name: string) {
  const branch = state.branches[branchId];
  const trimmed = name.trim();
  if (!branch || !trimmed) return false;
  const clash = Object.values(state.branches).some(
    (b) => b.id !== branchId && b.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (clash) return false;
  branch.name = trimmed;
  branch.updatedAt = Date.now();
  touch();
  return true;
}

export function createBranch(name: string, fromCommitId?: string) {
  commitPending();
  const branch = currentBranch();
  if (!branch) return undefined;
  const head = fromCommitId || branch.head;
  if (!state.commits[head]) return undefined;
  const named = g.uniqueBranchName(state.branches, name || "Branch");
  const created = g.createBranch(named, head, {
    forkedFrom: branch.id,
    forkedAt: head,
    selection: [...doc.selected],
  });
  state.branches[created.id] = created;
  state.currentBranch = created.id;
  touch();
  return created;
}

export function nameCommit(commitId: string, name: string) {
  const commit = state.commits[commitId];
  const trimmed = name.trim();
  if (!commit || !trimmed) return false;
  commit.name = trimmed;
  const branch = currentBranch();
  if (branch && branch.head === commitId) branch.updatedAt = Date.now();
  touch();
  return true;
}

export function nameCurrentVersion(name: string) {
  commitPending();
  const commit = currentCommit();
  return commit ? nameCommit(commit.id, name) : false;
}

// ---------------------------------------------------------------------------
// Restore previews
// ---------------------------------------------------------------------------

export type RestoreTarget =
  | { kind: "branch"; id: string }
  | { kind: "commit"; id: string }
  | { kind: "saved"; payload: HistoryPayload | null };

export interface RestorePreview {
  title: string;
  subtitle: string;
  target: RestoreTarget;
  snapshot: HistorySnapshot | null;
  comparison: Comparison | null;
  error: string | null;
}

export const preview = ref<RestorePreview | null>(null);

function describeCommit(commit: HistoryCommit) {
  return commit.name || commit.message || "Untitled version";
}

function buildPreview(
  title: string,
  subtitle: string,
  target: RestoreTarget,
  snapshot: HistorySnapshot | undefined,
): RestorePreview {
  if (!snapshot || !validSnapshot(snapshot)) {
    return {
      title,
      subtitle,
      target,
      snapshot: null,
      comparison: null,
      error: "This version has no valid data. Nothing was changed.",
    };
  }
  const clean = g.sanitizeSnapshot(snapshot);
  return {
    title,
    subtitle,
    target,
    snapshot: clean,
    comparison: compare(doc.shapes, clean.shapes),
    error: null,
  };
}

export function previewBranch(branchId: string) {
  commitPending();
  const branch = state.branches[branchId];
  const commit = branch && state.commits[branch.head];
  if (!branch || !commit) {
    preview.value = buildPreview(
      "Branch unavailable",
      "",
      { kind: "branch", id: branchId },
      undefined,
    );
    return;
  }
  const length = g.ancestry(state, branch.head).length;
  preview.value = buildPreview(
    branch.name,
    `${describeCommit(commit)} · ${length} version${length === 1 ? "" : "s"}`,
    { kind: "branch", id: branchId },
    commit.snapshot,
  );
}

export function previewCommit(commitId: string) {
  commitPending();
  const commit = state.commits[commitId];
  if (!commit) {
    preview.value = buildPreview(
      "Version unavailable",
      "",
      { kind: "commit", id: commitId },
      undefined,
    );
    return;
  }
  const reachable = isCommitOnCurrentBranch(commitId);
  preview.value = buildPreview(
    describeCommit(commit),
    `${new Date(commit.createdAt).toLocaleString()} · ${
      reachable ? "undo back to this version" : "restore as a new version"
    }`,
    { kind: "commit", id: commitId },
    commit.snapshot,
  );
}

export function previewSaved(payload: HistoryPayload) {
  commitPending();
  const branch = payload.branches?.[payload.currentBranch];
  const commit = branch && payload.commits?.[branch.head];
  const snapshot = commit ? commit.snapshot : payload.draft;
  preview.value = buildPreview(
    "Saved workspace",
    branch
      ? `Branch “${branch.name}” · ${Object.keys(payload.branches).length} branches`
      : "Local storage",
    { kind: "saved", payload },
    snapshot,
  );
}

export function previewSavedError(message: string) {
  preview.value = {
    title: "Saved workspace",
    subtitle: "",
    target: { kind: "saved", payload: null },
    snapshot: null,
    comparison: null,
    error: message,
  };
}

export function closePreview() {
  preview.value = null;
}

/** Walk back to an ancestor, keeping the skipped versions on the redo stack. */
function rewindTo(commitId: string): boolean {
  const branch = currentBranch();
  if (!branch) return false;
  if (branch.head === commitId) return true;
  const chain: string[] = [];
  let cursor: string | null = branch.head;
  const guard = new Set<string>();
  while (cursor && cursor !== commitId && !guard.has(cursor)) {
    guard.add(cursor);
    chain.push(cursor);
    cursor = state.commits[cursor]?.parent ?? null;
  }
  if (cursor !== commitId) return false;
  // chain is [head, parent, ... child-of-target]; redo pops from the end, so
  // the entry nearest the target must be pushed last.
  branch.redo.push(...chain);
  branch.head = commitId;
  branch.updatedAt = Date.now();
  return true;
}

/** Move forward to a version that is still on the redo stack. */
function redoTo(commitId: string): boolean {
  const branch = currentBranch();
  if (!branch) return false;
  // redo is ordered furthest → nearest, so the last entry is the next step.
  const index = branch.redo.indexOf(commitId);
  if (index < 0) return false;
  // Versions further along than the target remain redoable; everything up to
  // and including the target becomes ancestry again.
  branch.redo = branch.redo.slice(0, index);
  branch.head = commitId;
  branch.updatedAt = Date.now();
  return true;
}

export interface ConfirmResult {
  ok: boolean;
  error?: string;
}

/**
 * Apply a restore preview. Validation happens before any mutation, and the
 * document plus branch pointers are rolled back if applying still fails, so a
 * failed restore always leaves the current work intact.
 */
export function confirmPreview(): ConfirmResult {
  const plan = preview.value;
  if (!plan) return { ok: false, error: "Nothing to restore." };
  if (plan.target.kind === "saved") {
    if (!plan.target.payload)
      return { ok: false, error: plan.error || "Saved workspace unavailable." };
    const result = adoptPayload(plan.target.payload);
    if (result.ok) closePreview();
    else if (preview.value)
      preview.value.error = result.error || "Restore failed.";
    return result;
  }
  if (!plan.snapshot || !validSnapshot(plan.snapshot))
    return { ok: false, error: plan.error || "This version is unavailable." };

  // Snapshot everything the restore may touch so a failure can be undone.
  const rollback = {
    doc: snapshotOf(),
    currentBranch: state.currentBranch,
    branches: cloneBranches(),
    commits: { ...state.commits },
  };

  try {
    cancelEdit();
    const snapshot = g.sanitizeSnapshot(plan.snapshot);
    let selection: string[];
    if (plan.target.kind === "branch") {
      const target = state.branches[plan.target.id];
      if (!target) throw new Error("Branch no longer exists.");
      if (!state.commits[target.head])
        throw new Error("Branch has no restorable version.");
      const leaving = currentBranch();
      if (leaving) leaving.selection = [...doc.selected];
      state.currentBranch = target.id;
      selection = (target.selection ?? snapshot.selected).filter((id) =>
        snapshot.shapes.some((s) => s.id === id),
      );
      hydrate({ ...snapshot, selected: selection });
      target.selection = selection;
    } else {
      selection = snapshot.selected.filter((id) =>
        snapshot.shapes.some((s) => s.id === id),
      );
      const target = state.commits[plan.target.id];
      if (!target) throw new Error("This version no longer exists.");
      if (isCommitOnCurrentBranch(plan.target.id)) {
        if (!rewindTo(plan.target.id))
          throw new Error("This version is not reachable from the branch.");
        hydrate({ ...snapshot, selected: selection });
      } else if (redoTo(plan.target.id)) {
        hydrate({ ...snapshot, selected: selection });
      } else {
        // Not an ancestor and not a redo step: keep the current work and add
        // the state as a new version on the current branch so nothing is lost.
        const branch = currentBranch();
        if (!branch) throw new Error("No branch is checked out.");
        // Any undone versions still waiting in redo belong to the old future;
        // keep them on their own branch before the head moves.
        if (branch.redo.length) preserveFuture(branch);
        hydrate({ ...snapshot, selected: selection });
        const commit = g.createCommit(
          snapshotOf(),
          branch.head,
          `Restore “${describeCommit(target)}”`,
        );
        state.commits[commit.id] = commit;
        branch.head = commit.id;
        branch.updatedAt = Date.now();
      }
      const branch = currentBranch();
      if (branch) branch.selection = selection;
    }
    closePreview();
    touch();
    return { ok: true };
  } catch (error) {
    // Keep the current work exactly as it was.
    try {
      state.currentBranch = rollback.currentBranch;
      const restored = rollback.branches;
      for (const id of Object.keys(state.branches)) {
        if (!restored[id]) delete state.branches[id];
      }
      for (const [id, saved] of Object.entries(restored)) {
        if (state.branches[id]) Object.assign(state.branches[id], saved);
        else state.branches[id] = saved;
      }
      state.commits = rollback.commits;
      hydrate(rollback.doc);
    } catch {}
    const message = error instanceof Error ? error.message : "Restore failed.";
    if (preview.value) preview.value.error = message;
    return { ok: false, error: message };
  }
}

function cloneBranches(): Record<string, HistoryBranch> {
  return JSON.parse(JSON.stringify(state.branches)) as Record<
    string,
    HistoryBranch
  >;
}

/** Directly check out a branch without showing the preview UI. */
export function checkoutBranch(branchId: string): ConfirmResult {
  previewBranch(branchId);
  return confirmPreview();
}

// ---------------------------------------------------------------------------
// Loading and persistence
// ---------------------------------------------------------------------------

/**
 * Replace the whole history graph with a validated payload. Everything is
 * validated off to the side first; live state is only written once the payload
 * is known-good, and the document is rolled back if the final install fails.
 */
export function adoptPayload(payload: HistoryPayload): ConfirmResult {
  if (
    !payload ||
    payload.version !== 2 ||
    !payload.commits ||
    !payload.branches
  )
    return { ok: false, error: "Saved data is not a recognised workspace." };

  const before = snapshotOf();
  const commits: Record<string, HistoryCommit> = {};
  for (const [id, raw] of Object.entries(payload.commits)) {
    if (!raw || raw.id !== id || !validSnapshot(raw.snapshot)) continue;
    if (raw.parent !== null && typeof raw.parent !== "string") continue;
    commits[id] = {
      id,
      parent: typeof raw.parent === "string" ? raw.parent : null,
      snapshot: g.sanitizeSnapshot(raw.snapshot),
      message: typeof raw.message === "string" ? raw.message : "Edit",
      name:
        typeof raw.name === "string" && raw.name.trim() ? raw.name : undefined,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
      truncated: !!raw.truncated,
      key: typeof raw.key === "string" ? raw.key : undefined,
    };
  }
  for (const commit of Object.values(commits)) {
    if (commit.parent && !commits[commit.parent]) {
      commit.parent = null;
      commit.truncated = true;
    }
  }

  const branches: Record<string, HistoryBranch> = {};
  for (const [id, raw] of Object.entries(payload.branches)) {
    if (!raw || raw.id !== id || !commits[raw.head]) continue;
    branches[id] = {
      id,
      name:
        typeof raw.name === "string" && raw.name.trim() ? raw.name : "Branch",
      head: raw.head,
      redo: g.repairRedo(raw.head, raw.redo, commits),
      selection: Array.isArray(raw.selection)
        ? raw.selection.filter((x) => typeof x === "string")
        : undefined,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
      forkedFrom:
        typeof raw.forkedFrom === "string" && payload.branches[raw.forkedFrom]
          ? raw.forkedFrom
          : undefined,
      forkedAt:
        typeof raw.forkedAt === "string" && commits[raw.forkedAt]
          ? raw.forkedAt
          : undefined,
    };
  }
  const branchIds = Object.keys(branches);
  if (!branchIds.length)
    return { ok: false, error: "No restorable branch found." };

  // The payload must resolve to a real branch. Falling back to an arbitrary
  // branch would swap the user's current work for a different state.
  if (!branches[payload.currentBranch])
    return {
      ok: false,
      error: "The saved workspace's checked out branch is missing.",
    };
  const currentBranchId = payload.currentBranch;
  const headSnapshot = commits[branches[currentBranchId].head].snapshot;
  const draft =
    payload.draft && validSnapshot(payload.draft)
      ? g.sanitizeSnapshot(payload.draft)
      : undefined;

  // Work out the final document before touching any live state, so a failure
  // can never leave the graph and the document out of step.
  const target = draft ?? headSnapshot;
  const branch = branches[currentBranchId];
  const selection = (branch.selection ?? target.selected).filter((id) =>
    target.shapes.some((s) => s.id === id),
  );
  if (draft && !compare(headSnapshot.shapes, draft.shapes).same) {
    const recovered = g.createCommit(
      draft,
      branch.head,
      "Recovered unsaved work",
    );
    commits[recovered.id] = recovered;
    branch.head = recovered.id;
    branch.selection = selection;
    branch.updatedAt = Date.now();
  } else {
    branch.selection = selection;
  }

  const previous = {
    commits: state.commits,
    branches: state.branches,
    currentBranch: state.currentBranch,
  };
  try {
    state.commits = commits;
    state.branches = branches;
    state.currentBranch = currentBranchId;
    hydrate({ ...(draft ?? headSnapshot), selected: selection });
    cancelEdit();
    touch();
    return { ok: true };
  } catch (error) {
    state.commits = previous.commits;
    state.branches = previous.branches;
    state.currentBranch = previous.currentBranch;
    try {
      hydrate(before);
    } catch {}
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Restore failed.",
    };
  }
}

export function exportPayload(
  savedAt = Date.now(),
  draft?: HistorySnapshot,
): HistoryPayload {
  return g.serializePayload(state, savedAt, draft);
}

/** Mutable access reserved for storage maintenance (pruning). */
export function maintenanceState() {
  return state;
}

/** Snapshot of graph stats for the UI and diagnostics. */
export function historyCounts() {
  return {
    commits: Object.keys(state.commits).length,
    branches: Object.keys(state.branches).length,
    currentBranch: state.currentBranch,
  };
}

/**
 * Clear all history so the next `initHistory` starts from scratch. Reserved
 * for tests and for a future "reset workspace" command; normal editing never
 * needs it.
 */
export function resetHistory() {
  cancelEdit();
  preview.value = null;
  state.commits = {};
  state.branches = {};
  state.currentBranch = "";
  touch();
}
