"use client";

import { useCallback } from "react";
import { useLayoutStore } from "@/store/layout-store";
import { useMarketStore } from "@/store/market-store";

/** Select symbol in hub state and open/focus the pop-out detail panel. */
export function useFocusSymbol() {
  const spawnMarketSymbolPanel = useLayoutStore((state) => state.spawnMarketSymbolPanel);
  const setSelectedSymbol = useMarketStore((state) => state.setSelectedSymbol);

  return useCallback(
    (symbol: string) => {
      setSelectedSymbol(symbol);
      spawnMarketSymbolPanel(symbol);
    },
    [setSelectedSymbol, spawnMarketSymbolPanel],
  );
}
