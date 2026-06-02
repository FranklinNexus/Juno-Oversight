import type { PanelState } from "@/lib/layout/types";

export const DEFAULT_PANELS: PanelState[] = [
  { i: "panel-market", x: 0, y: 0, w: 7, h: 6, widgetType: "market" },
  { i: "panel-github", x: 7, y: 0, w: 5, h: 6, widgetType: "github" },
  { i: "panel-infra", x: 0, y: 6, w: 7, h: 6, widgetType: "infra" },
  { i: "panel-appslot", x: 7, y: 6, w: 5, h: 6, widgetType: "appslot" },
];

/** 左侧行情 + 右侧双栈 */
export const TRADING_PANELS: PanelState[] = [
  { i: "panel-market", x: 0, y: 0, w: 8, h: 12, widgetType: "market" },
  { i: "panel-github", x: 8, y: 0, w: 4, h: 6, widgetType: "github" },
  { i: "panel-infra", x: 8, y: 6, w: 4, h: 6, widgetType: "infra" },
];

/** 单窗全屏行情 */
export const FOCUS_MARKET_PANELS: PanelState[] = [
  { i: "panel-market", x: 0, y: 0, w: 12, h: 12, widgetType: "market" },
];

export type LayoutPresetId = "default" | "trading" | "focus-market";

export const LAYOUT_PRESETS: Record<LayoutPresetId, { label: string; panels: PanelState[] }> = {
  default: { label: "Default Quad", panels: DEFAULT_PANELS },
  trading: { label: "Trading Focus", panels: TRADING_PANELS },
  "focus-market": { label: "Market Full", panels: FOCUS_MARKET_PANELS },
};
