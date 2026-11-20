<script setup lang="ts">
import { path, exportSnapshot } from "../../drawing";
import { serialize } from "../lib/serialize";
import { download } from "../model/download";
import { save, restorePreview } from "../model/storage";

/**
 * Export reads the checked out branch's confirmed head. Any in-flight gesture
 * is committed at click time, and a restore preview that has not been
 * confirmed can never change what gets exported.
 */
function exportSvg() {
  const snapshot = exportSnapshot();
  const paths = snapshot.shapes.map(path);
  download(serialize(snapshot.shapes, paths));
}
</script>
<template>
  <div class="export">
    <button @click="restorePreview" data-testid="restore">Restore</button
    ><button @click="save({ immediate: true })">Save project</button
    ><button class="primary" data-testid="export" @click="exportSvg">
      Export SVG ↗
    </button>
  </div>
</template>
