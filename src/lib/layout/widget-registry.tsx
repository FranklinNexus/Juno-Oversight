import type { ComponentType } from "react";
import { ActiveRunPanel } from "@/components/widgets/ActiveRunPanel";
import { AlphaMarketIngestor } from "@/components/widgets/AlphaMarketIngestor";
import { AppIntegrationSlot } from "@/components/widgets/AppIntegrationSlot";
import { DailyDigestPanel } from "@/components/widgets/DailyDigestPanel";
import { GitHubRadar } from "@/components/widgets/GitHubRadar";
import { InfraTelemetry } from "@/components/widgets/InfraTelemetry";
import { MissionBoardPanel } from "@/components/widgets/MissionBoardPanel";
import { OverseerDaemonPanel } from "@/components/widgets/OverseerDaemonPanel";
import { PromotePanel } from "@/components/widgets/PromotePanel";
import { RunQueuePanel } from "@/components/widgets/RunQueuePanel";

export type WidgetPanelProps = {
  panelId: string;
};

export type WidgetType =
  | "runqueue"
  | "daily"
  | "activerun"
  | "daemon"
  | "mission"
  | "promote"
  | "market"
  | "github"
  | "infra"
  | "appslot";

export type WidgetDefinition = {
  type: WidgetType;
  label: string;
  code: string;
  Component: ComponentType<WidgetPanelProps>;
};

export const WIDGET_REGISTRY: WidgetDefinition[] = [
  {
    type: "runqueue",
    label: "Run Queue",
    code: "WIDGET-Q",
    Component: RunQueuePanel,
  },
  {
    type: "daily",
    label: "Daily Digest",
    code: "WIDGET-D",
    Component: DailyDigestPanel,
  },
  {
    type: "activerun",
    label: "Active Run",
    code: "WIDGET-R",
    Component: ActiveRunPanel,
  },
  {
    type: "daemon",
    label: "24/7 Scheduler",
    code: "WIDGET-S",
    Component: OverseerDaemonPanel,
  },
  {
    type: "mission",
    label: "Mission Board",
    code: "WIDGET-M",
    Component: MissionBoardPanel,
  },
  {
    type: "promote",
    label: "Promote",
    code: "WIDGET-P",
    Component: PromotePanel,
  },
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
    code: "WIDGET-D2",
    Component: AppIntegrationSlot,
  },
];

export function getWidgetDefinition(type: WidgetType): WidgetDefinition {
  return WIDGET_REGISTRY.find((item) => item.type === type) ?? WIDGET_REGISTRY[0];
}

/** Legacy persisted layouts may still reference removed widget types. */
export function normalizeWidgetType(type: string): WidgetType {
  if (WIDGET_REGISTRY.some((w) => w.type === type)) {
    return type as WidgetType;
  }
  return "runqueue";
}
