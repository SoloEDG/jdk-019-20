<script setup lang="ts">
import { computed } from "vue";
import { confirmPreview, closePreview, preview } from "../model/store";

const plan = computed(() => preview.value);
const comparison = computed(() => plan.value?.comparison ?? null);
const error = computed(() => plan.value?.error ?? null);

function confirm() {
  confirmPreview();
}

function cancel() {
  closePreview();
}
</script>

<template>
  <div v-if="plan" class="restore-backdrop" data-testid="restore-preview">
    <div class="restore-dialog" role="dialog" aria-modal="true">
      <header class="restore-head">
        <div>
          <small>RESTORE PREVIEW</small>
          <h3>{{ plan.title }}</h3>
          <p>{{ plan.subtitle }}</p>
        </div>
        <button
          class="restore-close"
          aria-label="Close preview"
          @click="cancel"
        >
          ✕
        </button>
      </header>

      <p v-if="error" class="restore-error" data-testid="restore-error">
        {{ error }}
      </p>

      <template v-if="comparison">
        <div
          class="restore-summary"
          :class="{ same: comparison.same }"
          data-testid="restore-summary"
        >
          {{ comparison.same ? "No differences" : comparison.summary }}
        </div>
        <ul v-if="!comparison.same" class="restore-diff">
          <li
            v-for="d in comparison.differences"
            :key="d.kind + d.id + d.detail"
            :data-kind="d.kind"
          >
            <i>{{ d.kind }}</i>
            <b>{{ d.label }}</b>
            <span>{{ d.detail }}</span>
          </li>
        </ul>
      </template>
      <p v-else-if="!error" class="restore-empty">
        This version has no previewable content.
      </p>

      <footer class="restore-actions">
        <button @click="cancel" data-testid="restore-cancel">
          Keep current
        </button>
        <button
          class="primary"
          :disabled="!!error"
          data-testid="restore-confirm"
          @click="confirm"
        >
          Restore this version
        </button>
      </footer>
    </div>
  </div>
</template>
