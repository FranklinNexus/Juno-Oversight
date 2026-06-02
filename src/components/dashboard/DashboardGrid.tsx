"use client";

import { HudViewport } from "@/components/dashboard/HudViewport";
import { GlobalControlHeader } from "@/components/dashboard/GlobalControlHeader";
import { AlphaMarketIngestor } from "@/components/widgets/AlphaMarketIngestor";
import { AppIntegrationSlot } from "@/components/widgets/AppIntegrationSlot";
import { GitHubRadar } from "@/components/widgets/GitHubRadar";
import { InfraTelemetry } from "@/components/widgets/InfraTelemetry";

export function DashboardGrid() {
  return (
    <HudViewport>
      <main className="hud-grid">
        <GlobalControlHeader />
        <AlphaMarketIngestor />
        <GitHubRadar />
        <InfraTelemetry />
        <AppIntegrationSlot />
      </main>
    </HudViewport>
  );
}
