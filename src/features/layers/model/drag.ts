import { beginEdit, endEdit } from "../../drawing";
import { doc } from "../../../shared/document";
import { translate } from "../lib/translate";

/**
 * Drag the selection. The gesture is opened once when dragging starts and
 * closed once when the pointer is released, so a whole drag is one version
 * even though `translateSelected` runs for every pointermove.
 */
export function beginMove(message = "Move layers") {
  beginEdit("move", { message });
}

export function translateSelected(x: number, y: number) {
  const affected = doc.shapes.filter((s) => doc.selected.includes(s.id));
  if (!affected.length) return;
  if (x === 0 && y === 0) return;
  beginEdit("move", { message: "Move layers" });
  affected.forEach((s) => translate(s, x, y));
}

export function endMove(message = "Move layers") {
  endEdit("move", message);
}
