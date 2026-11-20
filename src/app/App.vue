<script setup lang="ts">
import { computed, watch } from "vue";
import { doc } from "../shared/document";
import {
  Tools,
  path,
  create,
  add,
  seed,
  beginEdit,
  endEdit,
  undo,
  redo,
  canUndo,
  canRedo,
  revision,
  historyTick,
  initHistory,
  currentBranch,
} from "../features/drawing";
import { NodeOverlay, coordinates, select } from "../features/nodes";
import { Properties } from "../features/appearance";
import {
  Layers,
  translateSelected,
  beginMove,
  endMove,
} from "../features/layers";
import {
  ExportBar,
  restore,
  installStorageWatchers,
  storageStatus,
} from "../features/export";
import { HistoryPanel, RestorePreview } from "../features/history";
import type { Shape } from "../shared/types";

if (!restore()) {
  seed();
  doc.selected = doc.shapes.length
    ? [doc.shapes[Math.min(3, doc.shapes.length - 1)].id]
    : [];
  initHistory();
}
installStorageWatchers();

const paths = computed(() => doc.shapes.map(path));

/**
 * A pen path under construction. It is local, transient UI state: a restore
 * or branch switch clears it so no half-drawn path can leak into another
 * branch or an export.
 */
let drawing: Shape | undefined;
watch(
  () => doc.tool,
  () => {
    // Leaving pen mode finishes whatever path was drawn so far.
    finishPen();
  },
);
watch(revision, () => {
  // History replaced the document: the old shape object is stale. The gesture
  // that produced the revision already committed or cancelled it.
  drawing = undefined;
});

/** Commit the pen path as a single version. */
function finishPen() {
  if (!drawing) return;
  drawing = undefined;
  endEdit("pen", "Draw path");
}

function down(e: PointerEvent) {
  const svg = e.currentTarget as SVGSVGElement;
  const p = coordinates(e, svg);
  const id = (e.target as Element).getAttribute("data-shape");
  if (doc.tool === "pen") {
    // Re-opening the same key is a no-op while the path gesture is active. If
    // something (e.g. an export or branch switch) already committed it, a new
    // gesture starts so the next nodes are recorded as another version.
    beginEdit("pen", { message: "Draw path" });
    if (!drawing) drawing = create(p);
    add(drawing, p);
    const n = drawing.nodes.at(-1)!;
    const f = (ev: PointerEvent) => {
      const q = coordinates(ev, svg);
      n.out = q;
      n.in = { x: 2 * n.x - q.x, y: 2 * n.y - q.y };
    };
    const stop = () => window.removeEventListener("pointermove", f);
    window.addEventListener("pointermove", f);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return;
  }
  if (id) {
    select(id, e.shiftKey);
    if (doc.tool === "nodes") return;
    let last = p;
    let moved = false;
    const f = (ev: PointerEvent) => {
      const q = coordinates(ev, svg);
      const dx = q.x - last.x,
        dy = q.y - last.y;
      if (!dx && !dy) return;
      if (!moved) {
        moved = true;
        beginMove("Move layers");
      }
      translateSelected(dx, dy);
      last = q;
    };
    const stop = () => {
      window.removeEventListener("pointermove", f);
      if (moved) endMove("Move layers");
    };
    window.addEventListener("pointermove", f);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  } else doc.selected = [];
}

function finish() {
  finishPen();
  doc.tool = "select";
}

window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  )
    return;
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (meta && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
    return;
  }
  if (e.key === "Enter" || e.key === "Escape") finish();
});

const branchLabel = computed(() => {
  void historyTick.value;
  return currentBranch()?.name ?? "main";
});
</script>
<template>
  <header>
    <b class="brand">◈ forma <small>VECTOR STUDIO</small></b>
    <div>Bloom exploration <span> / Personal workspace</span></div>
    <ExportBar />
  </header>
  <div class="workspace">
    <div class="left">
      <h5>PROJECT <span>＋</span></h5>
      <p class="project">▣ Bloom / Artboard 01</p>
      <Tools /><Layers />
      <p class="signature">✧ Designed to explore.</p>
    </div>
    <main>
      <div class="toolbar">
        <span
          >Artboard 01　<small>800 × 600</small>
          <em class="branch" data-testid="current-branch"
            >⑂ {{ branchLabel }}</em
          ></span
        >
        <div>
          <button :disabled="!canUndo()" title="Undo" @click="undo">↶</button
          ><button :disabled="!canRedo()" title="Redo" @click="redo">↷</button
          ><button @click="doc.zoom = Math.max(0.4, doc.zoom - 0.1)">−</button
          >{{ Math.round(doc.zoom * 100) }}%<button
            @click="doc.zoom = Math.min(1.5, doc.zoom + 0.1)"
          >
            ＋
          </button>
        </div>
      </div>
      <div class="stage">
        <svg
          data-testid="canvas"
          :style="{
            width: 800 * doc.zoom + 'px',
            height: 600 * doc.zoom + 'px',
          }"
          viewBox="0 0 800 600"
          @pointerdown="down"
          @dblclick="finish"
        >
          <rect width="800" height="600" fill="#fffdfb" />
          <path
            v-for="s in doc.shapes"
            :key="s.id"
            :data-shape="s.id"
            :d="path(s)"
            :fill="s.fill"
            :stroke="s.stroke"
            :stroke-width="s.width"
            :opacity="s.opacity"
          />
          <NodeOverlay />
        </svg>
      </div>
      <footer>
        <span>● {{ storageStatus }}</span
        ><span>{{
          doc.tool === "pen"
            ? "Click / drag to draw · Enter to finish"
            : "Shift + click to select multiple · Drag to move"
        }}</span
        ><span>{{ doc.selected.length }} selected</span>
      </footer>
    </main>
    <div class="right">
      <HistoryPanel />
      <Properties />
    </div>
  </div>
  <RestorePreview />
</template>
