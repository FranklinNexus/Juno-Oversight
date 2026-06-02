"use client";

import { HudViewport } from "@/components/dashboard/HudViewport";
import { GlobalControlHeader } from "@/components/dashboard/GlobalControlHeader";
import { LayoutCanvas } from "@/components/dashboard/LayoutCanvas";

export function DashboardGrid() {
  return (
    <HudViewport>
      <div className="hud-shell flex flex-col h-full">
        <GlobalControlHeader />
        <LayoutCanvas />
      </div>
    </HudViewport>
  );
}
