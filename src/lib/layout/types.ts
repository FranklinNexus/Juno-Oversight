import type { WidgetType } from "@/lib/layout/widget-registry";

export type PanelState = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  widgetType: WidgetType;
};
