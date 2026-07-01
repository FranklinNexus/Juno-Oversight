import type { WidgetType } from "@/lib/layout/widget-registry";

export type PanelState = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  widgetType: WidgetType;
  /** In-panel content scale (title-bar wheel zoom). */
  contentZoom?: number;
  /** When set, market widget shows single-symbol detail (popped-out). */
  pinnedSymbol?: string;
  /** Higher values render above overlapping panels (click/drag bumps). */
  stackOrder?: number;
};
