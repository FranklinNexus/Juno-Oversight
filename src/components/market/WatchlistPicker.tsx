"use client";

import {
  INSTRUMENT_CATALOG,
  MARKET_LABELS,
  type MarketClass,
} from "@/lib/market/catalog";
import { useMarketStore } from "@/store/market-store";

const markets: Array<MarketClass | "all"> = ["all", "crypto", "us", "hk", "cn_a"];

export function WatchlistPicker() {
  const pickerOpen = useMarketStore((state) => state.pickerOpen);
  const watchlist = useMarketStore((state) => state.watchlist);
  const marketFilter = useMarketStore((state) => state.marketFilter);
  const setMarketFilter = useMarketStore((state) => state.setMarketFilter);
  const toggleWatchlist = useMarketStore((state) => state.toggleWatchlist);
  const setPickerOpen = useMarketStore((state) => state.setPickerOpen);

  if (!pickerOpen) return null;

  const rows =
    marketFilter === "all"
      ? INSTRUMENT_CATALOG
      : INSTRUMENT_CATALOG.filter((item) => item.market === marketFilter);

  return (
    <div className="absolute right-0 top-7 z-20 w-[280px] border border-[var(--border-dim)] bg-[var(--bg-elevated)] shadow-none">
      <div className="border-b border-[var(--border-dim)] px-2 py-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
          Watchlist ({watchlist.length}/12)
        </span>
        <button
          type="button"
          onClick={() => setPickerOpen(false)}
          className="text-[10px] text-[var(--text-muted)] uppercase"
        >
          Close
        </button>
      </div>

      <div className="px-2 py-1 flex gap-1 flex-wrap border-b border-[var(--border-dim)]">
        {markets.map((market) => (
          <button
            key={market}
            type="button"
            onClick={() => setMarketFilter(market)}
            className={`px-1.5 h-6 text-[10px] uppercase tracking-[0.1em] border ${
              marketFilter === market
                ? "border-[var(--accent-gold)] text-[var(--accent-gold)]"
                : "border-[var(--border-dim)] text-[var(--text-muted)]"
            }`}
          >
            {market === "all" ? "ALL" : MARKET_LABELS[market]}
          </button>
        ))}
      </div>

      <div className="max-h-[220px] overflow-y-auto">
        {rows.map((item) => {
          const active = watchlist.includes(item.symbol);
          return (
            <button
              key={item.symbol}
              type="button"
              onClick={() => toggleWatchlist(item.symbol)}
              className={`w-full text-left px-2 py-1 border-b border-[var(--border-dim)] hover:bg-[var(--bg-hover)] ${
                active ? "bg-[var(--bg-hover)]" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono-numeric text-xs">{item.symbol}</span>
                <span className="text-[10px] text-[var(--text-muted)]">
                  {MARKET_LABELS[item.market]}
                </span>
              </div>
              <div className="text-[10px] text-[var(--text-muted)]">{item.name}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
