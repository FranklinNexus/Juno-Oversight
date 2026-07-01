import type { PanelState } from "@/lib/layout/types";

/** Overseer default: queue + daily + active run + daemon + mission + promote */
export const DEFAULT_PANELS: PanelState[] = [
  { i: "panel-runqueue", x: 0, y: 0, w: 4, h: 4, widgetType: "runqueue" },
  { i: "panel-daily", x: 4, y: 0, w: 4, h: 4, widgetType: "daily" },
  { i: "panel-daemon", x: 8, y: 0, w: 4, h: 4, widgetType: "daemon" },
  { i: "panel-activerun", x: 0, y: 4, w: 6, h: 5, widgetType: "activerun" },
  { i: "panel-mission", x: 6, y: 4, w: 3, h: 5, widgetType: "mission" },
  { i: "panel-promote", x: 9, y: 4, w: 3, h: 5, widgetType: "promote" },
  { i: "panel-infra", x: 0, y: 9, w: 12, h: 3, widgetType: "infra" },
];

export const OPS_FOCUS_PANELS: PanelState[] = [
  { i: "panel-daily", x: 0, y: 0, w: 8, h: 7, widgetType: "daily" },
  { i: "panel-runqueue", x: 8, y: 0, w: 4, h: 7, widgetType: "runqueue" },
  { i: "panel-activerun", x: 0, y: 7, w: 12, h: 5, widgetType: "activerun" },
];

export const EDGE_FOCUS_PANELS: PanelState[] = [
  { i: "panel-infra", x: 0, y: 0, w: 12, h: 8, widgetType: "infra" },
  { i: "panel-runqueue", x: 0, y: 8, w: 6, h: 4, widgetType: "runqueue" },
  { i: "panel-daily", x: 6, y: 8, w: 6, h: 4, widgetType: "daily" },
];

export type LayoutPresetId = "default" | "ops-focus" | "edge-focus";

export const LAYOUT_PRESETS: Record<LayoutPresetId, { label: string; panels: PanelState[] }> = {
  default: { label: "Overseer Quad", panels: DEFAULT_PANELS },
  "ops-focus": { label: "Ops Focus", panels: OPS_FOCUS_PANELS },
  "edge-focus": { label: "Edge Focus", panels: EDGE_FOCUS_PANELS },
};
