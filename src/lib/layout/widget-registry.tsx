import type { ComponentType } from "react";
import { AlphaMarketIngestor } from "@/components/widgets/AlphaMarketIngestor";
import { AppIntegrationSlot } from "@/components/widgets/AppIntegrationSlot";
import { GitHubRadar } from "@/components/widgets/GitHubRadar";
import { InfraTelemetry } from "@/components/widgets/InfraTelemetry";

export type WidgetType = "market" | "github" | "infra" | "appslot";

export type WidgetDefinition = {
  type: WidgetType;
  label: string;
  code: string;
  Component: ComponentType;
};

export const WIDGET_REGISTRY: WidgetDefinition[] = [
  {
    type: "market",
    label: "Alpha Market",
    code: "WIDGET-A",
    Component: AlphaMarketIngestor,
  },
  {
    type: "github",
    label: "GitHub Radar",
    code: "WIDGET-B",
    Component: GitHubRadar,
  },
  {
    type: "infra",
    label: "Infrastructure",
    code: "WIDGET-C",
    Component: InfraTelemetry,
  },
  {
    type: "appslot",
    label: "App Integration",
    code: "WIDGET-D",
    Component: AppIntegrationSlot,
  },
];

export function getWidgetDefinition(type: WidgetType): WidgetDefinition {
  return WIDGET_REGISTRY.find((item) => item.type === type) ?? WIDGET_REGISTRY[0];
}
