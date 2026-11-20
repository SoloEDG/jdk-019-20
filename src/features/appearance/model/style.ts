import { beginEdit, endEdit } from "../../drawing";
import { doc } from "../../../shared/document";
import type { Shape } from "../../../shared/types";
import { styleLabels } from "../lib/labels";

/**
 * Apply an appearance change to the selection.
 *
 * Every call joins the same coalescing gesture per property, so dragging the
 * opacity slider or typing in the weight field produces exactly one version
 * rather than one per input event, while still storing full snapshots.
 */
export function style<K extends keyof Shape>(
  k: K,
  v: Shape[K],
  settle = false,
) {
  const key = "style:" + String(k);
  beginEdit(key, {
    coalesce: true,
    message: styleLabels[k] ?? "Edit appearance",
  });
  doc.shapes
    .filter((s) => doc.selected.includes(s.id))
    .forEach((s) => (s[k] = v));
  if (settle) endEdit(key, styleLabels[k] ?? "Edit appearance");
}
