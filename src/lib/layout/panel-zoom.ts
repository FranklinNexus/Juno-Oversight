export const PANEL_ZOOM_MIN = 0.75;
export const PANEL_ZOOM_MAX = 1.5;
export const PANEL_ZOOM_STEP = 0.05;

export function clampPanelZoom(zoom: number): number {
  return Math.max(PANEL_ZOOM_MIN, Math.min(PANEL_ZOOM_MAX, Number(zoom.toFixed(2))));
}

export function bumpPanelZoom(current: number, deltaY: number): number {
  const direction = deltaY > 0 ? -1 : 1;
  return clampPanelZoom(current + direction * PANEL_ZOOM_STEP);
}
