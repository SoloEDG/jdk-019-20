import { effectScope, ref, watch } from "vue";
import { doc } from "../../../shared/document";
import type { HistorySnapshot } from "../../../shared/types";
import { normalizePayload } from "../../history/lib/loader";
import { pruneHistory } from "../../history/lib/prune";
import {
  adoptPayload,
  exportPayload,
  hasPendingEdit,
  historyTick,
  maintenanceState,
  previewSaved,
  previewSavedError,
  snapshotOf,
  syncSelection,
} from "../../history";

const KEY = "forma-document";
const LEGACY_KEY = "forma-document-legacy";

/** How many versions to keep per branch before compacting older ones. */
const KEEP_PER_BRANCH = 50;
const KEEP_TOTAL = 300;

export const storageStatus = ref("All changes saved locally");
export const lastSavedAt = ref<number | null>(null);

let timer: ReturnType<typeof setTimeout> | null = null;
let saving = false;

function persist(draft?: HistorySnapshot) {
  if (saving) return;
  saving = true;
  try {
    const state = maintenanceState();
    // Compaction only ever cuts ancestry, never a branch head or named
    // version, so everything that survives stays restorable.
    pruneHistory(state, {
      keepPerBranch: KEEP_PER_BRANCH,
      keepTotal: KEEP_TOTAL,
    });
    const payload = exportPayload(Date.now(), draft);
    localStorage.setItem(KEY, JSON.stringify(payload));
    lastSavedAt.value = Date.now();
    storageStatus.value = "All changes saved locally";
  } catch {
    storageStatus.value =
      "Local storage unavailable — export to keep your work";
  } finally {
    saving = false;
  }
}

/**
 * Persist the whole graph (all branches, redo stacks and named versions) plus
 * an uncommitted draft, so reopening the browser finds the branches and any
 * edit that was still in progress.
 */
export function save(options: { immediate?: boolean } = {}) {
  if (options.immediate) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    persist(hasPendingEdit() ? snapshotOf() : undefined);
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    persist(hasPendingEdit() ? snapshotOf() : undefined);
  }, 250);
}

export interface ReadSaved {
  payload: ReturnType<typeof normalizePayload>["payload"];
  error: string | null;
  /** False when nothing was stored at all (as opposed to stored-but-invalid). */
  present: boolean;
  migrated: boolean;
  dropped: number;
}

/** Read and validate local storage without touching the document. */
export function readSaved(): ReadSaved {
  let text: string | null = null;
  try {
    text = localStorage.getItem(KEY);
  } catch {
    return {
      payload: null,
      error: "Local storage is unavailable in this browser.",
      present: false,
      migrated: false,
      dropped: 0,
    };
  }
  if (!text)
    return {
      payload: null,
      error: null,
      present: false,
      migrated: false,
      dropped: 0,
    };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      payload: null,
      error: "Saved workspace data is corrupted.",
      present: true,
      migrated: false,
      dropped: 0,
    };
  }
  const result = normalizePayload(raw, Date.now());
  if (result.payload && result.migrated) {
    // Keep the original single-state save so nothing is silently lost.
    try {
      localStorage.setItem(LEGACY_KEY, text);
    } catch {}
  }
  return {
    payload: result.payload,
    error: result.error,
    present: true,
    migrated: result.migrated,
    dropped: result.dropped,
  };
}

/**
 * Boot the session: adopt the saved graph when valid, otherwise keep whatever
 * is already in the document and show why nothing was restored. An empty
 * browser is not an error and does not open any dialog.
 */
export function restore(): boolean {
  const { payload, error, present } = readSaved();
  if (!payload) {
    if (present && error) {
      previewSavedError(error);
      storageStatus.value = error;
    }
    return false;
  }
  const result = adoptPayload(payload);
  if (!result.ok) {
    previewSavedError(result.error || "Saved workspace could not be restored.");
    storageStatus.value = result.error || "Restore failed";
    return false;
  }
  storageStatus.value = "All changes saved locally";
  return true;
}

/** Show a restore preview for the saved workspace instead of replacing it. */
export function restorePreview(): boolean {
  const { payload, error } = readSaved();
  if (!payload) {
    previewSavedError(error || "No saved workspace found in this browser.");
    return false;
  }
  previewSaved(payload);
  return true;
}

let watching = false;

export function installStorageWatchers() {
  if (watching) return;
  watching = true;
  // Detached from any component: autosave and selection syncing must outlive
  // the component that happened to boot the app, and must not be installed
  // twice if the app is mounted again.
  effectScope(true).run(() => {
    watch(historyTick, () => save());
    watch(
      () => doc.selected,
      () => {
        // Persist selection even between gestures so reopening finds the
        // branch exactly as it was left.
        syncSelection();
        save();
      },
      { deep: true },
    );
  });
  // Persist on page hide so an in-flight gesture is not lost.
  window.addEventListener("pagehide", () => save({ immediate: true }));
  window.addEventListener("beforeunload", () => save({ immediate: true }));
}
