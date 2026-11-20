// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import App from "./App.vue";
import { doc } from "../shared/document";
import * as store from "../features/history";

/**
 * Browser-level checks for the behaviours the history engine relies on at the
 * UI boundary: drag coalescing, selection ownership and export reading the
 * confirmed branch.
 */

class FakePoint {
  constructor(
    public x: number,
    public y: number,
  ) {}
  matrixTransform() {
    return { x: this.x, y: this.y };
  }
}

function stubGeometry() {
  vi.stubGlobal("DOMPoint", FakePoint);
  // Identity screen CTM: client coordinates equal SVG user coordinates.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (SVGElement.prototype as any).getScreenCTM = () => ({
    inverse: () => ({}),
  });
}

function pointer(type: string, x: number, y: number, target: EventTarget) {
  const event = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
}

/** Drag a shape by dispatching pointerdown, several moves and pointerup. */
function dragShape(shapeId: string, steps: number) {
  const shape = document.querySelector(`[data-shape="${shapeId}"]`)!;
  pointer("pointerdown", 0, 0, shape);
  for (let i = 0; i < steps; i++) pointer("pointermove", i + 1, 0, window);
  pointer("pointerup", steps, 0, window);
}

beforeEach(() => {
  localStorage.clear();
  store.resetHistory();
  doc.shapes = [];
  doc.selected = [];
  stubGeometry();
});

function mountApp() {
  return mount(App, { attachTo: document.body });
}

describe("app history integration", () => {
  it("turns a multi-step drag into exactly one version", async () => {
    const wrapper = mountApp();
    await wrapper.vm.$nextTick();
    const first = doc.shapes[0];
    const before = first.nodes[0].x;
    const root = store.currentCommit()!;

    dragShape(first.id, 30);
    await wrapper.vm.$nextTick();

    const head = store.currentCommit()!;
    expect(head.parent).toBe(root.id);
    const moved = doc.shapes.find((s) => s.id === first.id)!;
    expect(moved.nodes[0].x).toBeCloseTo(before + 30);
    wrapper.unmount();
  });

  it("previews a version, can cancel it, then restores it", async () => {
    const wrapper = mountApp();
    await wrapper.vm.$nextTick();
    const target = doc.shapes[0];
    dragShape(target.id, 20);
    await wrapper.vm.$nextTick();
    const headId = store.currentCommit()!.id;
    const undoRow = document.querySelectorAll('[data-testid="version-row"]');
    expect(undoRow.length).toBeGreaterThan(1);

    // Preview the previous version.
    (undoRow[1] as HTMLElement).click();
    await wrapper.vm.$nextTick();
    expect(
      document.querySelector('[data-testid="restore-preview"]'),
    ).toBeTruthy();
    const previewX = store.preview.value!.snapshot!.shapes.find(
      (s) => s.id === target.id,
    )!.nodes[0].x;
    expect(previewX).toBeCloseTo(target.nodes[0].x - 20);

    // Cancel: document untouched, current branch unchanged.
    (
      document.querySelector('[data-testid="restore-cancel"]') as HTMLElement
    ).click();
    await wrapper.vm.$nextTick();
    expect(
      document.querySelector('[data-testid="restore-preview"]'),
    ).toBeNull();
    expect(store.currentCommit()!.id).toBe(headId);

    // Preview again and confirm.
    (
      document.querySelectorAll('[data-testid="version-row"]')[1] as HTMLElement
    ).click();
    await wrapper.vm.$nextTick();
    (
      document.querySelector('[data-testid="restore-confirm"]') as HTMLElement
    ).click();
    await wrapper.vm.$nextTick();
    expect(store.currentCommit()!.id).not.toBe(headId);
    expect(doc.shapes.find((s) => s.id === target.id)!.nodes[0].x).toBeCloseTo(
      previewX,
    );
    // The skipped version is redoable, not lost.
    expect(store.canRedo()).toBe(true);
    wrapper.unmount();
  });

  it("names a version, forks a branch and shows both after a restart", async () => {
    let wrapper = mountApp();
    await wrapper.vm.$nextTick();
    const shape = doc.shapes[0];
    dragShape(shape.id, 8);
    await wrapper.vm.$nextTick();

    const input = document.querySelector(
      'input[aria-label="Version name"]',
    ) as HTMLInputElement;
    input.value = "Bloom checkpoint";
    input.dispatchEvent(new Event("input"));
    await wrapper.vm.$nextTick();
    (
      document.querySelector('[data-testid="name-version"]') as HTMLElement
    ).click();
    await wrapper.vm.$nextTick();
    expect(store.namedCommits().map((n) => n.commit.name)).toContain(
      "Bloom checkpoint",
    );

    const forkInput = document.querySelector(
      'input[aria-label="New branch name"]',
    ) as HTMLInputElement;
    forkInput.value = "Wildflower";
    forkInput.dispatchEvent(new Event("input"));
    await wrapper.vm.$nextTick();
    (
      document.querySelector('[data-testid="fork-branch"]') as HTMLElement
    ).click();
    await wrapper.vm.$nextTick();
    expect(store.currentBranch()!.name).toBe("Wildflower");
    expect(store.branchParent(store.currentBranch()!.id)!.name).toBe("main");

    // Persist, tear the app down, and boot it again.
    store.exportSnapshot();
    const { save } = await import("../features/export/model/storage");
    save({ immediate: true });
    wrapper.unmount();
    store.resetHistory();
    doc.shapes = [];

    wrapper = mountApp();
    await wrapper.vm.$nextTick();
    expect(
      store
        .branchList()
        .map((b) => b.name)
        .sort(),
    ).toEqual(["Wildflower", "main"]);
    expect(store.currentBranch()!.name).toBe("Wildflower");
    expect(store.namedCommits().map((n) => n.commit.name)).toContain(
      "Bloom checkpoint",
    );
    expect(doc.shapes.length).toBe(8);
    wrapper.unmount();
  });

  it("exports the checked out branch, not the previewed one", async () => {
    const wrapper = mountApp();
    await wrapper.vm.$nextTick();
    const shape = doc.shapes[0];
    dragShape(shape.id, 12);
    await wrapper.vm.$nextTick();

    // Create a second branch and switch back to main.
    const other = store.createBranch("Other")!;
    const main = store.branchList().find((b) => b.id !== other.id)!;
    store.checkoutBranch(main.id);

    // Preview the other branch and do not confirm.
    store.previewBranch(other.id);
    await wrapper.vm.$nextTick();

    const exported = store.exportSnapshot();
    expect(store.currentBranch()!.id).toBe(main.id);
    expect(JSON.stringify(exported.shapes)).toBe(
      JSON.stringify(store.currentCommit()!.snapshot.shapes),
    );
    wrapper.unmount();
  });

  it("keeps drawing state and selection owned by the branch that owns them", async () => {
    const wrapper = mountApp();
    await wrapper.vm.$nextTick();
    const shape = doc.shapes[0];
    dragShape(shape.id, 4);
    await wrapper.vm.$nextTick();

    // Select only the third object on main.
    const third = doc.shapes[2].id;
    const layerButton = Array.from(
      document.querySelectorAll<HTMLElement>(".layer"),
    ).find((el) => el.textContent?.includes(doc.shapes[2].name))!;
    layerButton.click();
    await wrapper.vm.$nextTick();
    expect(store.snapshotOf().selected).toEqual([third]);
    const main = store.currentBranch()!;
    expect(main.selection).toEqual([third]);

    const other = store.createBranch("Elsewhere")!;
    expect(store.snapshotOf().selected).toEqual([third]);
    // A forked branch starts with its own copy of the selection.
    expect(other.selection).toEqual([third]);

    // Select something else on the new branch.
    doc.selected = [doc.shapes[0].id];
    await wrapper.vm.$nextTick();
    expect(other.selection).toEqual([doc.shapes[0].id]);

    store.checkoutBranch(main.id);
    await wrapper.vm.$nextTick();
    // Returning to main restores main's selection, not the other branch's.
    expect(store.snapshotOf().selected).toEqual([third]);

    store.checkoutBranch(other.id);
    await wrapper.vm.$nextTick();
    expect(store.snapshotOf().selected).toEqual([doc.shapes[0].id]);
    wrapper.unmount();
  });
});
