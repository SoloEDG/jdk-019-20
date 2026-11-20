import type { Shape } from "../../../shared/types";

export const styleLabels: Partial<Record<keyof Shape, string>> = {
  fill: "Change fill",
  stroke: "Change stroke",
  width: "Change weight",
  opacity: "Change opacity",
  closed: "Toggle closed path",
};
