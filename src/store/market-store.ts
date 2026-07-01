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
  WATCHLIST_MAX,
} from "@/lib/market/sanitize-watchlist";

export type MarketHubTab = "watchlist" | "all" | MarketClass;

export type MarketFilter = "all" | MarketClass;

type MarketStore = {
  watchlist: string[];
  hubTab: MarketHubTab;
  selectedSymbol: string;
  searchOpen: boolean;
  pickerOpen: boolean;
  marketFilter: MarketFilter;
  setHubTab: (tab: MarketHubTab) => void;
  setSelectedSymbol: (symbol: string) => void;
  toggleWatchlist: (symbol: string) => void;
  setSearchOpen: (open: boolean) => void;
  setPickerOpen: (open: boolean) => void;
  setMarketFilter: (filter: MarketFilter) => void;
};

const HUB_TABS = new Set<MarketHubTab>([
  "watchlist",
  "all",
  "crypto",
  "us",
  "hk",
  "cn_a",
]);

function sanitizeHubTab(value: unknown): MarketHubTab {
  if (typeof value === "string" && HUB_TABS.has(value as MarketHubTab)) {
    return value as MarketHubTab;
  }
  return "watchlist";
}

export const useMarketStore = create<MarketStore>()(
  persist(
    (set, get) => ({
      watchlist: DEFAULT_WATCHLIST,
      hubTab: "watchlist",
      selectedSymbol: DEFAULT_WATCHLIST[0],
      searchOpen: false,
      pickerOpen: false,
      marketFilter: "all",
      setHubTab: (tab) => set({ hubTab: tab }),
      setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),
      setSearchOpen: (open) => set({ searchOpen: open }),
      setPickerOpen: (open) => set({ pickerOpen: open }),
      setMarketFilter: (marketFilter) => set({ marketFilter }),
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
        if (current.length >= WATCHLIST_MAX) return;
        set({ watchlist: [...current, symbol] });
      },
    }),
    {
      name: "juno-market-store",
      version: 2,
      migrate: (persisted) => {
        if (!persisted || typeof persisted !== "object") {
          return {
            watchlist: [...DEFAULT_WATCHLIST],
            hubTab: "watchlist" as const,
            selectedSymbol: DEFAULT_WATCHLIST[0],
          };
        }
        const state = persisted as {
          watchlist?: unknown;
          hubTab?: unknown;
          marketFilter?: unknown;
          selectedSymbol?: unknown;
        };
        const watchlist = sanitizeWatchlist(state.watchlist);
        const hubTab =
          state.hubTab !== undefined
            ? sanitizeHubTab(state.hubTab)
            : state.marketFilter === "all"
              ? "all"
              : sanitizeHubTab(state.marketFilter);
        return {
          watchlist,
          hubTab,
          selectedSymbol: sanitizeSelectedSymbol(state.selectedSymbol, watchlist),
        };
      },
      merge: (persisted, current) => {
        if (!persisted || typeof persisted !== "object") return current;
        const state = persisted as {
          watchlist?: unknown;
          hubTab?: unknown;
          marketFilter?: unknown;
          selectedSymbol?: unknown;
        };
        const watchlist = sanitizeWatchlist(state.watchlist);
        const hubTab =
          state.hubTab !== undefined
            ? sanitizeHubTab(state.hubTab)
            : state.marketFilter !== undefined
              ? state.marketFilter === "all"
                ? "all"
                : sanitizeHubTab(state.marketFilter)
              : current.hubTab;
        return {
          ...current,
          watchlist,
          hubTab,
          selectedSymbol: sanitizeSelectedSymbol(state.selectedSymbol, watchlist),
        };
      },
      partialize: (state) => ({
        watchlist: state.watchlist,
        hubTab: state.hubTab,
        selectedSymbol: state.selectedSymbol,
      }),
    },
  ),
);
