"use client";

import { HudViewport } from "@/components/dashboard/HudViewport";
import { GlobalControlHeader } from "@/components/dashboard/GlobalControlHeader";
import { HudThemeSync } from "@/components/dashboard/HudThemeSync";
import { LayoutCanvas } from "@/components/dashboard/LayoutCanvas";

export function DashboardGrid() {
  return (
    <HudViewport>
      <HudThemeSync />
      <div className="hud-shell flex flex-col h-full">
        <GlobalControlHeader />
        <LayoutCanvas />
      </div>
    </HudViewport>
  );
}
