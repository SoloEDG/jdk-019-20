/**
 * Compare two whole-document states.
 *
 * States are only treated as equal when every node anchor and handle, every
 * appearance value, grouping and the stacking order all match. Object counts
 * are never used as a shortcut: a path with the same number of nodes can still
 * differ in shape, style or position.
 */

import type { Point, Shape } from "../../../shared/types";

export type DifferenceKind = "shape" | "appearance" | "layer";

export interface Difference {
  kind: DifferenceKind;
  /** Shape name (with id fallback) so differences are readable in the UI. */
  label: string;
  id: string;
  detail: string;
}

export interface Comparison {
  same: boolean;
  differences: Difference[];
  /** Human readable one-line summary of the differences. */
  summary: string;
  added: number;
  removed: number;
  changed: number;
  reordered: number;
}

function label(s: Shape) {
  return s.name || s.id;
}

function near(a: number, b: number) {
  return Math.abs(a - b) < 1e-9;
}

function samePoint(a: Point, b: Point) {
  return near(a.x, b.x) && near(a.y, b.y);
}

function sameNodes(a: Shape, b: Shape) {
  if (a.nodes.length !== b.nodes.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    const x = a.nodes[i],
      y = b.nodes[i];
    if (!samePoint(x, y) || !samePoint(x.in, y.in) || !samePoint(x.out, y.out))
      return false;
  }
  return true;
}

function appearanceOf(s: Shape) {
  return [
    s.fill,
    s.stroke,
    s.width,
    s.opacity,
    s.closed ? "closed" : "open",
    s.group ?? "",
  ].join("|");
}

function appearanceDetail(before: Shape, after: Shape) {
  const changes: string[] = [];
  const clamp = (v: number) => Math.round(v * 1000) / 1000;
  if (before.fill !== after.fill)
    changes.push(`fill ${before.fill} → ${after.fill}`);
  if (before.stroke !== after.stroke)
    changes.push(`stroke ${before.stroke} → ${after.stroke}`);
  if (!near(before.width, after.width))
    changes.push(`weight ${clamp(before.width)} → ${clamp(after.width)}`);
  if (!near(before.opacity, after.opacity))
    changes.push(`opacity ${clamp(before.opacity)} → ${clamp(after.opacity)}`);
  if (before.closed !== after.closed)
    changes.push(after.closed ? "path closed" : "path opened");
  if ((before.group ?? "") !== (after.group ?? "")) changes.push("grouping");
  return changes.join(", ") || "appearance changed";
}

function geometryDetail(before: Shape, after: Shape) {
  if (before.nodes.length !== after.nodes.length) {
    return `${before.nodes.length} → ${after.nodes.length} anchors`;
  }
  let moved = 0,
    handles = 0;
  for (let i = 0; i < before.nodes.length; i++) {
    const x = before.nodes[i],
      y = after.nodes[i];
    if (!samePoint(x, y)) moved++;
    if (!samePoint(x.in, y.in) || !samePoint(x.out, y.out)) handles++;
  }
  const parts: string[] = [];
  if (moved) parts.push(`${moved} anchor${moved === 1 ? "" : "s"} moved`);
  if (handles)
    parts.push(`${handles} handle${handles === 1 ? "" : "s"} changed`);
  return parts.join(", ") || "geometry changed";
}

/**
 * Compare two states and describe every difference. Nodes, appearance and
 * stacking order are all inspected independently of each other.
 */
export function compare(before: Shape[], after: Shape[]): Comparison {
  const differences: Difference[] = [];
  const beforeById = new Map(before.map((s) => [s.id, s]));
  const afterById = new Map(after.map((s) => [s.id, s]));
  let added = 0,
    removed = 0,
    changed = 0,
    reordered = 0;

  for (const s of after) {
    if (!beforeById.has(s.id)) {
      added++;
      differences.push({
        kind: "shape",
        id: s.id,
        label: label(s),
        detail: "added",
      });
    }
  }

  for (const s of before) {
    const other = afterById.get(s.id);
    if (!other) {
      removed++;
      differences.push({
        kind: "shape",
        id: s.id,
        label: label(s),
        detail: "removed",
      });
      continue;
    }
    if (!sameNodes(s, other)) {
      changed++;
      differences.push({
        kind: "shape",
        id: s.id,
        label: label(s),
        detail: geometryDetail(s, other),
      });
    }
    if (appearanceOf(s) !== appearanceOf(other)) {
      if (sameNodes(s, other)) changed++;
      differences.push({
        kind: "appearance",
        id: s.id,
        label: label(s),
        detail: appearanceDetail(s, other),
      });
    }
  }

  // Stacking order: only compare the relative order of shapes present in both
  // states, so adding or removing an object does not create order noise.
  const beforeOrder = before
    .filter((s) => afterById.has(s.id))
    .map((s) => s.id);
  const afterOrder = after.filter((s) => beforeById.has(s.id)).map((s) => s.id);
  const beforeIndex = new Map(beforeOrder.map((id, i) => [id, i]));
  const displaced = afterOrder.filter((id, i) => beforeIndex.get(id) !== i);
  if (displaced.length) {
    reordered = displaced.length;
    const names = displaced
      .slice(0, 3)
      .map((id) => label(afterById.get(id)!))
      .join(", ");
    differences.push({
      kind: "layer",
      id: displaced[0],
      label: names,
      detail:
        displaced.length > 3
          ? `${displaced.length} layers restacked`
          : "restacked",
    });
  }

  const parts: string[] = [];
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  if (changed) parts.push(`${changed} edited`);
  if (reordered) parts.push(`${reordered} restacked`);
  return {
    same: differences.length === 0,
    differences,
    summary: parts.join(" · ") || "Identical states",
    added,
    removed,
    changed,
    reordered,
  };
}
