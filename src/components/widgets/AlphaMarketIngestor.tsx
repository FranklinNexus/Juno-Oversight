"use client";

import { MarketHubPanel } from "@/components/market/MarketHubPanel";
import { SymbolDetailPanel } from "@/components/market/SymbolDetailPanel";
import type { WidgetPanelProps } from "@/lib/layout/widget-registry";
import { useLayoutStore } from "@/store/layout-store";

export function AlphaMarketIngestor({ panelId }: WidgetPanelProps) {
  const pinnedSymbol = useLayoutStore(
    (state) => state.panels.find((panel) => panel.i === panelId)?.pinnedSymbol,
  );

  if (pinnedSymbol) {
    return <SymbolDetailPanel symbol={pinnedSymbol} />;
  }

  return <MarketHubPanel />;
}
