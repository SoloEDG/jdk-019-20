<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import {
  branchHistory,
  branchList,
  branchParent,
  canRedo,
  canUndo,
  createBranch,
  currentBranch,
  currentCommit,
  historyCounts,
  historyTick,
  nameCommit,
  nameCurrentVersion,
  namedCommits,
  previewBranch,
  previewCommit,
  redo,
  renameBranch,
  undo,
} from "../model/store";

const versionName = ref("");
const branchName = ref("");
const renaming = ref<string | null>(null);
const renameValue = ref("");
const namingVersion = ref<string | null>(null);
const versionNameValue = ref("");
const message = ref("");
const openBranch = ref<string | null>(null);

const branches = computed(() => {
  void historyTick.value;
  return branchList();
});
const named = computed(() => {
  void historyTick.value;
  return namedCommits();
});
const current = computed(() => {
  void historyTick.value;
  return currentBranch();
});
const headLabel = computed(() => {
  void historyTick.value;
  const commit = currentCommit();
  if (!commit) return "No version yet";
  return commit.name || commit.message || "Untitled version";
});
const counts = computed(() => {
  void historyTick.value;
  return historyCounts();
});

interface VersionRow {
  id: string;
  label: string;
  time: string;
  head: boolean;
  name: string | null;
}
const versions = computed<VersionRow[]>(() => {
  void historyTick.value;
  const branch = currentBranch();
  if (!branch) return [];
  return branchHistory(branch.id).map((c, i) => ({
    id: c.id,
    label: c.name || c.message || "Untitled version",
    time: new Date(c.createdAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    head: i === 0,
    name: c.name ?? null,
  }));
});

function saveVersion() {
  if (!versionName.value.trim()) {
    message.value = "Type a name first";
    return;
  }
  if (nameCurrentVersion(versionName.value)) {
    versionName.value = "";
    message.value = "Version named";
  } else {
    message.value = "Could not name this version";
  }
}

function fork() {
  const branch = createBranch(branchName.value || "Branch");
  branchName.value = "";
  message.value = branch
    ? `Created “${branch.name}”`
    : "Could not create branch";
  if (branch) openBranch.value = branch.id;
}

function startRename(id: string, name: string) {
  renaming.value = id;
  renameValue.value = name;
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>("[data-rename]");
    el?.focus();
    el?.select();
  });
}

function commitRename() {
  if (!renaming.value) return;
  const ok = renameBranch(renaming.value, renameValue.value);
  message.value = ok ? "" : "That branch name is already used";
  if (ok) renaming.value = null;
}

function startNameVersion(id: string, currentName: string | null) {
  namingVersion.value = id;
  versionNameValue.value = currentName ?? "";
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>("[data-version-name]");
    el?.focus();
    el?.select();
  });
}

function commitVersionName() {
  if (!namingVersion.value) return;
  const ok = nameCommit(namingVersion.value, versionNameValue.value);
  message.value = ok ? "" : "Type a name first";
  if (ok) namingVersion.value = null;
}

function parentName(id: string) {
  return branchParent(id)?.name ?? null;
}

function toggleVersions(id: string) {
  openBranch.value = openBranch.value === id ? null : id;
}
</script>

<template>
  <section class="history">
    <h3>
      History <span>{{ counts.commits }}</span>
    </h3>
    <div class="hist-now">
      <small>ON BRANCH</small>
      <b data-testid="current-branch-name">{{ current?.name ?? "—" }}</b>
      <span data-testid="current-version">{{ headLabel }}</span>
    </div>
    <div class="hist-actions">
      <button :disabled="!canUndo()" title="Undo (Ctrl+Z)" @click="undo">
        ↶</button
      ><button :disabled="!canRedo()" title="Redo (Ctrl+Shift+Z)" @click="redo">
        ↷
      </button>
    </div>
    <div class="hist-form">
      <input
        v-model="versionName"
        placeholder="Name this version"
        aria-label="Version name"
        @keydown.enter="saveVersion"
      />
      <button @click="saveVersion" data-testid="name-version">Pin</button>
    </div>

    <h4>VERSIONS ({{ current?.name ?? "—" }})</h4>
    <ol class="hist-versions">
      <li v-for="v in versions" :key="v.id" :class="{ head: v.head }">
        <template v-if="namingVersion === v.id">
          <input
            v-model="versionNameValue"
            data-version-name
            class="hist-version-input"
            aria-label="Version label"
            @keydown.enter="commitVersionName"
            @keydown.esc="namingVersion = null"
            @blur="commitVersionName"
          />
        </template>
        <button
          v-else
          class="hist-version"
          data-testid="version-row"
          :title="
            v.head
              ? 'Current version'
              : 'Preview this version before restoring it'
          "
          @click="previewCommit(v.id)"
        >
          <b>{{ v.label }}</b>
          <span v-if="v.head">current</span>
          <span v-else>{{ v.time }}</span>
        </button>
        <button
          class="hist-rename"
          title="Name this version"
          data-testid="name-row"
          @click="startNameVersion(v.id, v.name)"
        >
          ✎
        </button>
      </li>
    </ol>

    <h4>BRANCHES</h4>
    <div class="hist-branches">
      <div
        v-for="b in branches"
        :key="b.id"
        class="hist-branch"
        :class="{ current: b.id === current?.id }"
      >
        <div class="hist-branch-head">
          <template v-if="renaming === b.id">
            <input
              v-model="renameValue"
              data-rename
              aria-label="Branch name"
              @keydown.enter="commitRename"
              @keydown.esc="renaming = null"
              @blur="commitRename"
            />
          </template>
          <button
            v-else
            class="hist-name"
            data-testid="branch-name"
            title="Double-click to rename"
            @dblclick="startRename(b.id, b.name)"
          >
            {{ b.name }}
          </button>
          <span v-if="b.id === current?.id" class="hist-pill">current</span>
        </div>
        <div class="hist-meta">
          {{ branchHistory(b.id).length }} versions
          <template v-if="parentName(b.id)">
            · forked from {{ parentName(b.id) }}
          </template>
        </div>
        <div class="hist-branch-actions">
          <button
            data-testid="preview-branch"
            :disabled="b.id === current?.id"
            @click="previewBranch(b.id)"
          >
            Preview
          </button>
          <button @click="startRename(b.id, b.name)">Rename</button>
          <button @click="toggleVersions(b.id)">
            {{ openBranch === b.id ? "Hide" : "Versions" }}
          </button>
        </div>
        <ol v-if="openBranch === b.id" class="hist-versions compact">
          <li v-for="c in branchHistory(b.id)" :key="c.id">
            <button
              class="hist-version"
              :title="'Preview this version'"
              @click="previewCommit(c.id)"
            >
              <b>{{ c.name || c.message || "Untitled version" }}</b>
              <span>{{ new Date(c.createdAt).toLocaleTimeString() }}</span>
            </button>
          </li>
        </ol>
      </div>
    </div>
    <div class="hist-form">
      <input
        v-model="branchName"
        placeholder="New branch name"
        aria-label="New branch name"
        @keydown.enter="fork"
      />
      <button @click="fork" data-testid="fork-branch">Fork</button>
    </div>

    <h4>PINNED VERSIONS</h4>
    <p v-if="!named.length" class="hist-empty">
      Name a version to keep it across branches.
    </p>
    <button
      v-for="n in named"
      :key="n.commit.id"
      class="hist-version"
      data-testid="named-version"
      @click="previewCommit(n.commit.id)"
    >
      <b>{{ n.commit.name }}</b>
      <span>{{ n.branch?.name ?? "detached" }}</span>
    </button>
    <p v-if="message" class="hist-message">{{ message }}</p>
  </section>
</template>
