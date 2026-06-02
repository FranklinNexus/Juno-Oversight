import { GRID_COLS, GRID_MAX_ROWS } from "@/lib/layout/constants";
import type { PanelState } from "@/lib/layout/types";

export function clampPanel(panel: PanelState): PanelState {
  const w = Math.max(3, Math.min(GRID_COLS, panel.w));
  const h = Math.max(2, Math.min(GRID_MAX_ROWS, panel.h));
  const x = Math.max(0, Math.min(GRID_COLS - w, panel.x));
  const y = Math.max(0, Math.min(GRID_MAX_ROWS - h, panel.y));
  return { ...panel, x, y, w, h };
}
