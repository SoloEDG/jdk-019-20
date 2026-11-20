import type { HistorySnapshot, Point, Shape } from "./types";

export function isPoint(v: unknown): v is Point {
  const p = v as Point | null;
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

export function validShape(s: Shape | null | undefined): s is Shape {
  return (
    !!s &&
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    Array.isArray(s.nodes) &&
    s.nodes.every((n) => isPoint(n) && isPoint(n.in) && isPoint(n.out)) &&
    typeof s.fill === "string" &&
    /^(none|#[0-9a-f]{3,8})$/i.test(s.fill) &&
    typeof s.stroke === "string" &&
    /^#[0-9a-f]{3,8}$/i.test(s.stroke) &&
    Number.isFinite(s.width) &&
    Number.isFinite(s.opacity) &&
    typeof s.closed === "boolean" &&
    (s.group === undefined || typeof s.group === "string")
  );
}

export function validShapes(value: unknown): value is Shape[] {
  return Array.isArray(value) && value.every((s) => validShape(s as Shape));
}

export function validSnapshot(value: unknown): value is HistorySnapshot {
  const v = value as HistorySnapshot | null;
  return (
    !!v &&
    validShapes(v.shapes) &&
    Array.isArray(v.selected) &&
    v.selected.every((id) => typeof id === "string")
  );
}
