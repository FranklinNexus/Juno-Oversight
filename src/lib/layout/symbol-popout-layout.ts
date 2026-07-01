import { GRID_COLS, GRID_MAX_ROWS } from "@/lib/layout/constants";
import type { PanelState } from "@/lib/layout/types";

/** Default grid footprint for popped-out symbol detail (right column, chart-friendly). */
export const SYMBOL_POPOUT_SIZE = { w: 5, h: 14 } as const;

type PanelPlacement = Pick<PanelState, "x" | "y" | "w" | "h" | "pinnedSymbol">;

/**
 * Place new symbol windows on the right with a slight cascade so stacks stay usable.
 */
export function findSymbolPopoutPosition(
  panels: PanelPlacement[],
  size: { w: number; h: number },
): { x: number; y: number } {
  const stackIndex = panels.filter((panel) => panel.pinnedSymbol).length;
  const cascade = stackIndex % 6;
  const x = Math.max(0, GRID_COLS - size.w - (cascade % 3));
  const y = Math.min(GRID_MAX_ROWS - size.h, 1 + Math.floor(cascade / 2));
  return { x, y };
}

export function nextStackOrder(panels: PanelState[]): number {
  if (panels.length === 0) return 1;
  return Math.max(0, ...panels.map((panel) => panel.stackOrder ?? 0)) + 1;
}

/** Keep one pop-out per symbol (highest stackOrder wins). */
export function dedupePinnedSymbolPanels(panels: PanelState[]): PanelState[] {
  const bestBySymbol = new Map<string, PanelState>();

  for (const panel of panels) {
    if (!panel.pinnedSymbol) continue;
    const prev = bestBySymbol.get(panel.pinnedSymbol);
    if (!prev || (panel.stackOrder ?? 0) >= (prev.stackOrder ?? 0)) {
      bestBySymbol.set(panel.pinnedSymbol, panel);
    }
  }

  if (bestBySymbol.size === 0) return panels;

  const dropIds = new Set<string>();
  for (const panel of panels) {
    if (!panel.pinnedSymbol) continue;
    const keep = bestBySymbol.get(panel.pinnedSymbol);
    if (keep && keep.i !== panel.i) dropIds.add(panel.i);
  }

  return dropIds.size === 0 ? panels : panels.filter((panel) => !dropIds.has(panel.i));
}

export function findPinnedSymbolPanel(
  panels: PanelState[],
  symbol: string,
): PanelState | undefined {
  return panels.find((panel) => panel.pinnedSymbol === symbol);
}

export function normalizeSymbolPopoutPanel(panel: PanelState): PanelState {
  if (!panel.pinnedSymbol) return panel;
  const needsSize =
    panel.h < SYMBOL_POPOUT_SIZE.h || panel.w < SYMBOL_POPOUT_SIZE.w;
  return needsSize ? { ...panel, ...SYMBOL_POPOUT_SIZE } : panel;
}
