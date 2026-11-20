import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Shape } from "../../../shared/types";
import { doc } from "../../../shared/document";
import * as store from "../../history";
import { pruneHistory } from "../../history/lib/prune";

/** Minimal localStorage that can also simulate a full disk. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    fail: false,
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (this.fail) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    key: () => null,
    length: 0,
  };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(async () => {
  storage = fakeStorage();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  store.resetHistory();
  doc.shapes = [shape("a", 0), shape("b", 100)];
  doc.selected = ["a"];
  store.initHistory();
  const mod = await import("./storage");
  mod.storageStatus.value = "All changes saved locally";
});

function node(x: number, y = 0) {
  return { x, y, in: { x: x - 10, y }, out: { x: x + 10, y } };
}

function shape(id: string, x: number): Shape {
  return {
    id,
    name: id,
    nodes: [node(x), node(x + 40, 30)],
    closed: true,
    fill: "#7754d6",
    stroke: "#ffffff",
    width: 2,
    opacity: 1,
  };
}

function move(id: string, dx: number) {
  const s = doc.shapes.find((s) => s.id === id)!;
  s.nodes.forEach((n) => {
    n.x += dx;
    n.in.x += dx;
    n.out.x += dx;
  });
}

describe("local persistence", () => {
  it("saves the whole graph so branches and names survive a reload", async () => {
    const { save, restore, readSaved } = await import("./storage");
    store.beginEdit("move", { message: "Move a" });
    move("a", 6);
    store.endEdit("move", "Move a");
    store.nameCurrentVersion("Bloom v1");
    store.createBranch("Detour");
    store.beginEdit("move", { message: "Move b" });
    move("b", 2);
    store.endEdit("move", "Move b");
    save({ immediate: true });

    const read = readSaved();
    expect(read.error).toBeNull();
    expect(read.payload).toBeTruthy();
    expect(Object.keys(read.payload!.branches)).toHaveLength(2);

    // Simulate a reload: wipe live state, then restore from storage.
    store.resetHistory();
    doc.shapes = [];
    expect(restore()).toBe(true);
    expect(
      store
        .branchList()
        .map((b) => b.name)
        .sort(),
    ).toEqual(["Detour", "main"]);
    expect(store.namedCommits().map((n) => n.commit.name)).toContain(
      "Bloom v1",
    );
    expect(doc.shapes).toHaveLength(2);
  });

  it("persists an in-progress draft and recovers it as a version", async () => {
    const { save, restore } = await import("./storage");
    store.beginEdit("move", { message: "Pending" });
    move("a", 11);
    // No endEdit: the gesture is still open when the page is saved/hidden.
    save({ immediate: true });
    store.resetHistory();
    doc.shapes = [];
    expect(restore()).toBe(true);
    expect(doc.shapes.find((s) => s.id === "a")!.nodes[0].x).toBe(11);
    expect(store.currentCommit()!.message).toBe("Recovered unsaved work");
  });

  it("keeps working when localStorage rejects writes", async () => {
    const { save, storageStatus } = await import("./storage");
    storage.fail = true;
    save({ immediate: true });
    expect(storageStatus.value).toMatch(/unavailable/i);
    // The document itself is untouched.
    expect(doc.shapes).toHaveLength(2);
  });

  it("does not open a preview for an empty browser", async () => {
    const { restore } = await import("./storage");
    expect(restore()).toBe(false);
    expect(store.preview.value).toBeNull();
  });

  it("reports corrupted storage without touching the document", async () => {
    const { restore } = await import("./storage");
    storage.setItem("forma-document", "{not json");
    const before = JSON.stringify(doc.shapes);
    expect(restore()).toBe(false);
    expect(store.preview.value?.error).toBeTruthy();
    expect(JSON.stringify(doc.shapes)).toBe(before);
  });

  it("migrates a legacy single-state save", async () => {
    const { restore } = await import("./storage");
    const legacy = [shape("a", 3), shape("b", 50)];
    storage.setItem("forma-document", JSON.stringify(legacy));
    store.resetHistory();
    doc.shapes = [];
    expect(restore()).toBe(true);
    expect(doc.shapes).toHaveLength(2);
    expect(storage.getItem("forma-document-legacy")).toBeTruthy();
  });

  it("compacts old versions on save but keeps heads and names restorable", async () => {
    const { save } = await import("./storage");
    for (let i = 0; i < 120; i++) {
      store.beginEdit("move", { message: "Move " + i });
      move("a", 1);
      store.endEdit("move", "Move " + i);
    }
    store.nameCurrentVersion("Pinned");
    save({ immediate: true });
    const state = store.maintenanceState();
    const total = Object.keys(state.commits).length;
    expect(total).toBeLessThanOrEqual(300);
    // The head still holds the full document.
    expect(store.currentCommit()!.snapshot.shapes[0].nodes[0].x).toBe(120);
    expect(store.namedCommits()).toHaveLength(1);
    // Every surviving commit has a complete snapshot and a valid parent.
    for (const commit of Object.values(state.commits)) {
      expect(commit.snapshot.shapes.length).toBeGreaterThan(0);
      if (commit.parent) expect(state.commits[commit.parent]).toBeTruthy();
    }
  });
});

describe("prune invariants", () => {
  it("keeps redo entries unless the budget forces them out", () => {
    store.beginEdit("move", { message: "One" });
    move("a", 1);
    store.endEdit("move", "One");
    store.beginEdit("move", { message: "Two" });
    move("a", 1);
    store.endEdit("move", "Two");
    store.undo();
    const branch = store.currentBranch()!;
    expect(branch.redo).toHaveLength(1);
    pruneHistory(store.maintenanceState(), {
      keepPerBranch: 20,
      keepTotal: 20,
    });
    expect(branch.redo).toHaveLength(1);
    expect(store.canRedo()).toBe(true);
  });
});
