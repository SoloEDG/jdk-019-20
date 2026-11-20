import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HistoryPayload, Shape } from "../../../shared/types";
import { doc } from "../../../shared/document";
import * as store from "../model/store";
import { pruneHistory } from "../lib/prune";
import { compare } from "../lib/compare";

function node(x: number, y = 0) {
  return {
    x,
    y,
    in: { x: x - 10, y },
    out: { x: x + 10, y },
  };
}

function shape(id: string, x: number, extra: Partial<Shape> = {}): Shape {
  return {
    id,
    name: id,
    nodes: [node(x), node(x + 40, 30)],
    closed: true,
    fill: "#7754d6",
    stroke: "#ffffff",
    width: 2,
    opacity: 1,
    ...extra,
  };
}

function move(id: string, dx: number) {
  const target = doc.shapes.find((s) => s.id === id)!;
  target.nodes.forEach((n) => {
    n.x += dx;
    n.in.x += dx;
    n.out.x += dx;
  });
}

function reset(source: Shape[] = [shape("a", 0), shape("b", 100)]) {
  store.resetHistory();
  doc.shapes = JSON.parse(JSON.stringify(source));
  doc.selected = ["a"];
  store.initHistory();
}

function edit(key: string, message: string, change: () => void) {
  store.beginEdit(key, { message });
  change();
  store.endEdit(key, message);
}

function payload(): HistoryPayload {
  return JSON.parse(JSON.stringify(store.exportPayload())) as HistoryPayload;
}

beforeEach(() => {
  // Each test starts from a clean graph and document.
  reset();
});

afterEach(() => {
  store.closePreview();
  store.cancelEdit();
});

describe("gesture coalescing", () => {
  it("folds many drag steps into one version", () => {
    const root = store.currentCommit()!;
    store.beginEdit("move", { message: "Move layers" });
    for (let i = 0; i < 40; i++) move("a", 1);
    store.endEdit("move", "Move layers");
    const head = store.currentCommit()!;
    expect(head.parent).toBe(root.id);
    expect(head.snapshot.shapes.find((s) => s.id === "a")!.nodes[0].x).toBe(40);
  });

  it("does not create a version for a drag that changes nothing", () => {
    const root = store.currentCommit()!;
    store.beginEdit("move", { message: "Move layers" });
    move("a", 3);
    move("a", -3);
    store.endEdit("move", "Move layers");
    expect(store.currentCommit()!.id).toBe(root.id);
    expect(store.canUndo()).toBe(false);
  });

  it("keeps node-level and appearance changes distinct versions", () => {
    edit("move", "Move layers", () => move("a", 5));
    edit("style:fill", "Change fill", () => (doc.shapes[0].fill = "#000000"));
    const history = store.branchHistory(store.currentBranch()!.id);
    expect(history).toHaveLength(3);
    expect(history[0].snapshot.shapes[0].fill).toBe("#000000");
    expect(history[1].snapshot.shapes[0].nodes[0].x).toBe(5);
  });
});

describe("branching", () => {
  it("preserves the undone future as another branch when editing diverges", () => {
    edit("move", "Move a", () => move("a", 20));
    const tip = store.currentCommit()!;
    store.undo();
    edit("move", "Move b", () => move("b", 8));

    expect(store.currentBranch()!.name).toBe("main");
    const alternative = store
      .branchList()
      .find((b) => b.name.includes("undone"))!;
    expect(alternative).toBeTruthy();
    expect(
      store
        .commitById(alternative.head)!
        .snapshot.shapes.find((s) => s.id === "a")!.nodes[0].x,
    ).toBe(20);

    // Nothing was lost: switching to the preserved branch restores the old future.
    store.previewBranch(alternative.id);
    const preview = store.preview.value!;
    expect(preview.snapshot!.shapes.find((s) => s.id === "a")!.nodes[0].x).toBe(
      20,
    );
    expect(store.confirmPreview().ok).toBe(true);
    expect(doc.shapes.find((s) => s.id === "a")!.nodes[0].x).toBe(20);
    expect(store.commitById(tip.id)).toBeTruthy();
  });

  it("keeps each branch's redo stack independent", () => {
    edit("move", "Move a", () => move("a", 10));
    const main = store.currentBranch()!;
    store.undo();
    edit("move", "Move b", () => move("b", 5));
    // main's redo was moved onto the preserved branch
    expect(main.redo).toHaveLength(0);
    const preserved = store
      .branchList()
      .find((b) => b.name.includes("undone"))!;
    expect(preserved.redo).toHaveLength(0);
    expect(store.branchHistory(preserved.id).length).toBe(2);

    store.previewBranch(main.id);
    store.confirmPreview();
    expect(store.canRedo()).toBe(false);
    expect(doc.shapes.find((s) => s.id === "b")!.nodes[0].x).toBe(105);
  });

  it("forks from the current head and links back to the parent branch", () => {
    const fork = store.createBranch("Experiment")!;
    expect(store.currentBranch()!.id).toBe(fork.id);
    expect(store.branchParent(fork.id)!.name).toBe("main");
  });
});

describe("restore previews", () => {
  it("compares nodes, appearance and stacking rather than object counts", () => {
    // Same object count in both states; only geometry differs.
    edit("move", "Move a", () => move("a", 30));
    const tip = store.currentCommit()!;
    store.undo();
    expect(doc.shapes).toHaveLength(2);

    store.previewCommit(tip.id);
    const preview = store.preview.value!;
    expect(preview.error).toBeNull();
    expect(preview.snapshot!.shapes).toHaveLength(2);
    expect(preview.comparison!.same).toBe(false);
    expect(
      preview.comparison!.differences.some((d) => d.kind === "shape"),
    ).toBe(true);
    expect(preview.comparison!.summary).toContain("edited");

    // Appearance-only differences are reported separately from geometry.
    store.closePreview();
    const current = store.currentCommit()!;
    store.beginEdit("style:fill", { message: "Change fill" });
    doc.shapes[0].fill = "#000000";
    store.endEdit("style:fill", "Change fill");
    store.previewCommit(current.id);
    expect(
      store.preview.value!.comparison!.differences.some(
        (d) => d.kind === "appearance",
      ),
    ).toBe(true);
  });

  it("reports stacking differences between same-sized states", () => {
    const root = store.currentCommit()!;
    store.beginEdit("reorder", { message: "Reorder layers" });
    doc.shapes = [doc.shapes[1], doc.shapes[0]];
    store.endEdit("reorder", "Reorder layers");
    store.previewCommit(root.id);
    expect(
      store.preview.value!.comparison!.differences.some(
        (d) => d.kind === "layer",
      ),
    ).toBe(true);
  });

  it("never mutates the document while previewing", () => {
    edit("move", "Move a", () => move("a", 15));
    const before = JSON.stringify(doc.shapes);
    const branch = store.currentBranch()!;
    store.previewBranch(branch.id);
    expect(JSON.stringify(doc.shapes)).toBe(before);
    store.closePreview();
    expect(JSON.stringify(doc.shapes)).toBe(before);
  });

  it("keeps the current work when a restore target is missing", () => {
    const beforeDoc = JSON.stringify(doc.shapes);
    const beforeCount = store.historyCounts().commits;
    store.previewCommit("does-not-exist");
    expect(store.preview.value!.error).toBeTruthy();
    expect(store.confirmPreview().ok).toBe(false);
    expect(JSON.stringify(doc.shapes)).toBe(beforeDoc);
    expect(store.historyCounts().commits).toBe(beforeCount);
  });

  it("restores an ancestor and keeps skipped versions redoable", () => {
    edit("move", "Move a", () => move("a", 5));
    edit("move", "Move a", () => move("a", 5));
    const rows = store.branchHistory(store.currentBranch()!.id);
    expect(rows).toHaveLength(3);

    store.previewCommit(rows[1].id);
    expect(store.confirmPreview().ok).toBe(true);
    expect(doc.shapes.find((s) => s.id === "a")!.nodes[0].x).toBe(5);
    expect(store.canRedo()).toBe(true);
    store.redo();
    expect(doc.shapes.find((s) => s.id === "a")!.nodes[0].x).toBe(10);
  });
});

describe("export and persistence", () => {
  it("exports the confirmed branch head, committing in-flight work first", () => {
    edit("move", "Move a", () => move("a", 7));
    store.beginEdit("move", { message: "Move" });
    move("a", 7);
    const exported = store.exportSnapshot();
    expect(store.hasPendingEdit()).toBe(false);
    expect(exported.shapes.find((s) => s.id === "a")!.nodes[0].x).toBe(14);
    expect(JSON.stringify(store.confirmedSnapshot.value.shapes)).toBe(
      JSON.stringify(store.currentCommit()!.snapshot.shapes),
    );
  });

  it("ignores an unconfirmed preview when exporting", () => {
    edit("move", "Move a", () => move("a", 9));
    const head = JSON.stringify(store.confirmedSnapshot.value.shapes);
    const other = store.createBranch("Other")!;
    store.previewBranch(store.branchList()[0].id);
    expect(JSON.stringify(store.exportSnapshot().shapes)).toBe(head);
    expect(store.currentBranch()!.id).toBe(other.id);
  });

  it("round-trips branches, names and the draft through a payload", () => {
    edit("move", "Move a", () => move("a", 4));
    store.nameCurrentVersion("Named one");
    store.createBranch("Feature");
    edit("move", "Move b", () => move("b", 2));
    store.beginEdit("move", { message: "Pending" });
    move("a", 1);
    const saved = JSON.parse(
      JSON.stringify(store.exportPayload(Date.now(), store.snapshotOf())),
    ) as HistoryPayload;
    expect(saved.draft).toBeTruthy();

    const branchNames = Object.values(saved.branches)
      .map((b) => b.name)
      .sort();
    const result = store.adoptPayload(saved);
    expect(result.ok).toBe(true);
    expect(
      store
        .branchList()
        .map((b) => b.name)
        .sort(),
    ).toEqual(branchNames);
    expect(store.namedCommits().map((n) => n.commit.name)).toContain(
      "Named one",
    );
    // The draft was recovered as its own version rather than being lost.
    expect(store.currentCommit()!.message).toBe("Recovered unsaved work");
    expect(doc.shapes.find((s) => s.id === "a")!.nodes[0].x).toBe(5);
  });

  it("rejects a payload whose checked out branch is missing", () => {
    edit("move", "Move a", () => move("a", 6));
    const saved = payload();
    saved.currentBranch = "ghost";
    const before = JSON.stringify(doc.shapes);
    const result = store.adoptPayload(saved);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(doc.shapes)).toBe(before);
  });
});

describe("compaction", () => {
  it("keeps heads, named versions and fork points restorable", () => {
    for (let i = 0; i < 40; i++) {
      edit("move", "Move " + i, () => move("a", 1));
    }
    store.nameCurrentVersion("Keep me");
    const namedId = store.currentCommit()!.id;
    const headId = store.currentCommit()!.id;
    const state = store.maintenanceState();
    const report = pruneHistory(state, { keepPerBranch: 5, keepTotal: 6 });
    expect(report.removed).toBeGreaterThan(0);
    expect(state.commits[headId]).toBeTruthy();
    expect(state.commits[namedId]).toBeTruthy();
    expect(state.commits[headId].snapshot.shapes[0].nodes[0].x).toBe(40);
    expect(state.commits[headId].snapshot.shapes[0].nodes).toHaveLength(2);
    // A truncated head still restores completely on its own.
    expect(
      state.commits[headId].parent === null ||
        !!state.commits[state.commits[headId].parent!],
    ).toBe(true);
  });

  it("never makes a surviving version depend on a pruned ancestor", () => {
    for (let i = 0; i < 20; i++) edit("move", "Move " + i, () => move("a", 1));
    const state = store.maintenanceState();
    pruneHistory(state, { keepPerBranch: 3, keepTotal: 3 });
    for (const commit of Object.values(state.commits)) {
      if (commit.parent) expect(state.commits[commit.parent]).toBeTruthy();
      // Every snapshot is complete, regardless of ancestry.
      expect(Array.isArray(commit.snapshot.shapes)).toBe(true);
    }
  });
});

describe("compare", () => {
  it("detects restacking independent of additions", () => {
    const before = [shape("a", 0), shape("b", 10)];
    const after = [shape("b", 10), shape("a", 0)];
    expect(compare(before, after).reordered).toBe(2);
    expect(compare(before, [shape("a", 0)]).reordered).toBe(0);
  });
});
