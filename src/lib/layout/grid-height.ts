import { GRID_ROW_HEIGHT } from "@/lib/layout/constants";
import type { PanelState } from "@/lib/layout/types";

type GridMetrics = {
  marginY: number;
  paddingY: number;
};

const DEFAULT_METRICS: GridMetrics = { marginY: 2, paddingY: 2 };

/** Pixel height for react-grid-layout when autoSize is enabled. */
export function gridPixelHeight(
  panels: PanelState[],
  metrics: GridMetrics = DEFAULT_METRICS,
): number {
  if (panels.length === 0) return 0;
  const maxRow = Math.max(...panels.map((panel) => panel.y + panel.h));
  const { marginY, paddingY } = metrics;
  return paddingY * 2 + maxRow * GRID_ROW_HEIGHT + Math.max(0, maxRow - 1) * marginY;
}
