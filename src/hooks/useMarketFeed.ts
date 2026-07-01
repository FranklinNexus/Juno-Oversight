"use client";

import { useCallback, useMemo } from "react";
import { useLiveMarketFeed } from "@/hooks/useLiveMarketFeed";
import { useMockWebSocket } from "@/hooks/useMockWebSocket";
import type { MarketPayload } from "@/lib/market/payload";
import { generateMarketBatch } from "@/mocks/generators/market-feed";
import { useHudStore } from "@/store/hud-store";

export type MarketFeedResult = {
  rows: MarketPayload[] | null;
  error: string | null;
  source: "mock" | "live";
};

export function useMarketFeed(symbols: string[]): MarketFeedResult {
  const mode = useHudStore((state) => state.mode);
  const marketDataMode = useHudStore((state) => state.marketDataMode);
  const symbolsKey = symbols.join(",");
  const stableSymbols = useMemo(
    () => symbols,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by joined list
    [symbolsKey],
  );

  const generate = useCallback(
    () => generateMarketBatch(stableSymbols),
    [stableSymbols],
  );

  const mockData = useMockWebSocket({
    feedId: "market",
    mode,
    generate,
    enabled: marketDataMode === "mock",
  });

  const live = useLiveMarketFeed(stableSymbols, mode);

  if (marketDataMode === "live") {
    return { rows: live.data, error: live.error, source: "live" };
  }
  return { rows: mockData, error: null, source: "mock" };
}
