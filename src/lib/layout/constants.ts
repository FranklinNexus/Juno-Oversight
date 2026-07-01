export const GRID_COLS = 12;
export const GRID_ROW_HEIGHT = 36;
/** Logical rows; canvas scrolls vertically when content exceeds viewport. */
export const GRID_MAX_ROWS = 24;

export type PanelSizePreset = "quarter" | "half" | "full";

export const SIZE_PRESETS: Record<PanelSizePreset, { w: number; h: number }> = {
  quarter: { w: 6, h: 3 },
  half: { w: 6, h: 6 },
  full: { w: 12, h: 12 },
};
