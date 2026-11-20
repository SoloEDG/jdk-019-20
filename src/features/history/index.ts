export { default as HistoryPanel } from "./ui/HistoryPanel.vue";
export { default as RestorePreview } from "./ui/RestorePreview.vue";
export { compare } from "./lib/compare";
export type { Comparison, Difference } from "./lib/compare";
export {
  beginEdit,
  endEdit,
  cancelEdit,
  commitPending,
  hasPendingEdit,
  syncSelection,
  undo,
  redo,
  canUndo,
  canRedo,
  revision,
  historyTick,
  snapshotOf,
  confirmedSnapshot,
  exportSnapshot,
  initHistory,
  isReady,
  branchList,
  currentBranch,
  currentCommit,
  branchHistory,
  branchParent,
  namedCommits,
  nameCurrentVersion,
  nameCommit,
  renameBranch,
  createBranch,
  preview,
  previewBranch,
  previewCommit,
  previewSaved,
  previewSavedError,
  confirmPreview,
  closePreview,
  checkoutBranch,
  commitById,
  exportPayload,
  adoptPayload,
  maintenanceState,
  historyCounts,
  resetHistory,
} from "./model/store";
export type {
  RestorePreview as RestorePreviewData,
  RestoreTarget,
  ConfirmResult,
} from "./model/store";
export { normalizePayload } from "./lib/loader";
export { pruneHistory } from "./lib/prune";
