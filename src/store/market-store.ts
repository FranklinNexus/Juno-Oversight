"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_WATCHLIST,
  type MarketClass,
} from "@/lib/market/catalog";
import {
  sanitizeSelectedSymbol,
  sanitizeWatchlist,
} from "@/lib/market/sanitize-watchlist";

type MarketStore = {
  watchlist: string[];
  marketFilter: MarketClass | "all";
  selectedSymbol: string;
  pickerOpen: boolean;
  setMarketFilter: (filter: MarketClass | "all") => void;
  setSelectedSymbol: (symbol: string) => void;
  toggleWatchlist: (symbol: string) => void;
  setPickerOpen: (open: boolean) => void;
};

const MARKET_FILTERS = new Set<MarketClass | "all">([
  "all",
  "crypto",
  "us",
  "hk",
  "cn_a",
]);

function sanitizeMarketFilter(value: unknown): MarketClass | "all" {
  if (typeof value === "string" && MARKET_FILTERS.has(value as MarketClass | "all")) {
    return value as MarketClass | "all";
  }
  return "all";
}

export const useMarketStore = create<MarketStore>()(
  persist(
    (set, get) => ({
      watchlist: DEFAULT_WATCHLIST,
      marketFilter: "all",
      selectedSymbol: DEFAULT_WATCHLIST[0],
      pickerOpen: false,
      setMarketFilter: (filter) => set({ marketFilter: filter }),
      setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),
      setPickerOpen: (open) => set({ pickerOpen: open }),
      toggleWatchlist: (symbol) => {
        const current = get().watchlist;
        if (current.includes(symbol)) {
          const next = current.filter((item) => item !== symbol);
          set({
            watchlist: next.length > 0 ? next : current,
            selectedSymbol:
              get().selectedSymbol === symbol ? (next[0] ?? current[0]) : get().selectedSymbol,
          });
          return;
        }
        if (current.length >= 12) return;
        set({ watchlist: [...current, symbol] });
      },
    }),
    {
      name: "juno-market-store",
      version: 1,
      migrate: (persisted) => {
        if (!persisted || typeof persisted !== "object") {
          return {
            watchlist: [...DEFAULT_WATCHLIST],
            marketFilter: "all" as const,
            selectedSymbol: DEFAULT_WATCHLIST[0],
          };
        }
        const state = persisted as {
          watchlist?: unknown;
          marketFilter?: unknown;
          selectedSymbol?: unknown;
        };
        const watchlist = sanitizeWatchlist(state.watchlist);
        return {
          watchlist,
          marketFilter: sanitizeMarketFilter(state.marketFilter),
          selectedSymbol: sanitizeSelectedSymbol(state.selectedSymbol, watchlist),
        };
      },
      merge: (persisted, current) => {
        if (!persisted || typeof persisted !== "object") return current;
        const state = persisted as {
          watchlist?: unknown;
          marketFilter?: unknown;
          selectedSymbol?: unknown;
        };
        const watchlist = sanitizeWatchlist(state.watchlist);
        return {
          ...current,
          watchlist,
          marketFilter: sanitizeMarketFilter(state.marketFilter),
          selectedSymbol: sanitizeSelectedSymbol(state.selectedSymbol, watchlist),
        };
      },
      partialize: (state) => ({
        watchlist: state.watchlist,
        marketFilter: state.marketFilter,
        selectedSymbol: state.selectedSymbol,
      }),
    },
  ),
);
