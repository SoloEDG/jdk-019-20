import { beginEdit, endEdit } from "../../drawing";
import { doc } from "../../../shared/document";

/**
 * Group the selection. The whole operation is one version; regrouping an
 * already-existing group is a no-op and therefore never creates a phantom
 * version.
 */
export function group() {
  const selected = doc.shapes.filter((s) => doc.selected.includes(s.id));
  if (selected.length < 2) return;
  beginEdit("group", { message: "Group layers" });
  const id = crypto.randomUUID();
  const top = doc.shapes
    .map((s) => doc.selected.includes(s.id))
    .lastIndexOf(true);
  const below = doc.shapes
    .slice(0, top + 1)
    .filter((s) => !doc.selected.includes(s.id));
  const above = doc.shapes.slice(top + 1);
  selected.forEach((s) => (s.group = id));
  doc.shapes = [...below, ...selected, ...above];
  endEdit("group", "Group layers");
}

export function reorder(delta: number) {
  const first = doc.shapes.find((s) => doc.selected.includes(s.id));
  if (!first) return;
  const blocks: (typeof doc.shapes)[] = [];
  for (const shape of doc.shapes) {
    const last = blocks.at(-1);
    if (shape.group && last?.[0].group === shape.group) last.push(shape);
    else blocks.push([shape]);
  }
  const i = blocks.findIndex((b) => b.some((s) => s.id === first.id)),
    j = i + delta;
  if (j < 0 || j >= blocks.length) return;
  beginEdit("reorder", { message: "Reorder layers" });
  [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  doc.shapes = blocks.flat();
  endEdit("reorder", "Reorder layers");
}

export function remove() {
  if (!doc.selected.length) return;
  beginEdit("remove", { message: "Delete layers" });
  doc.shapes = doc.shapes.filter((s) => !doc.selected.includes(s.id));
  doc.selected = [];
  endEdit("remove", "Delete layers");
}
