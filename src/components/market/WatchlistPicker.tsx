"use client";

import { useMemo, useState } from "react";
import {
  DataTable,
  FilterBar,
  HudButton,
  HudSegment,
  TagChip,
} from "@/components/ui";
import { INSTRUMENT_CATALOG, MARKET_LABELS } from "@/lib/market/catalog";
import { useMarketStore } from "@/store/market-store";

const marketOptions = [
  { id: "all" as const, label: "ALL" },
  { id: "crypto" as const, label: MARKET_LABELS.crypto },
  { id: "us" as const, label: MARKET_LABELS.us },
  { id: "hk" as const, label: MARKET_LABELS.hk },
  { id: "cn_a" as const, label: MARKET_LABELS.cn_a },
];

export function WatchlistPicker() {
  const pickerOpen = useMarketStore((state) => state.pickerOpen);
  const watchlist = useMarketStore((state) => state.watchlist);
  const marketFilter = useMarketStore((state) => state.marketFilter);
  const setMarketFilter = useMarketStore((state) => state.setMarketFilter);
  const toggleWatchlist = useMarketStore((state) => state.toggleWatchlist);
  const setPickerOpen = useMarketStore((state) => state.setPickerOpen);
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const base =
      marketFilter === "all"
        ? INSTRUMENT_CATALOG
        : INSTRUMENT_CATALOG.filter((item) => item.market === marketFilter);
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (item) =>
        item.symbol.toLowerCase().includes(q) || item.name.toLowerCase().includes(q),
    );
  }, [marketFilter, query]);

  if (!pickerOpen) return null;

  return (
    <div className="absolute right-0 top-7 z-20 w-[300px] border border-[var(--border-dim)] bg-[var(--bg-elevated)] shadow-none">
      <div className="border-b border-[var(--border-dim)] px-2 py-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
          Watchlist ({watchlist.length}/12)
        </span>
        <HudButton variant="ghost" onClick={() => setPickerOpen(false)}>
          Close
        </HudButton>
      </div>

      <div className="px-2 py-1 border-b border-[var(--border-dim)]">
        <HudSegment
          value={marketFilter}
          options={marketOptions}
          onChange={setMarketFilter}
        />
      </div>

      <FilterBar
        query={query}
        onQueryChange={setQuery}
        placeholder="Symbol or name"
        className="border-b-0"
      />

      <div className="max-h-[220px] overflow-y-auto hud-scroll px-1 pb-1">
        <DataTable
          columns={[
            {
              id: "sym",
              header: "SYM",
              cell: (row) => row.symbol,
            },
            {
              id: "mkt",
              header: "MKT",
              align: "right",
              cell: (row) => MARKET_LABELS[row.market],
            },
            {
              id: "on",
              header: "ON",
              align: "right",
              width: "48px",
              cell: (row) =>
                watchlist.includes(row.symbol) ? (
                  <TagChip tone="gold">YES</TagChip>
                ) : (
                  <span className="text-[var(--text-muted)]">—</span>
                ),
            },
          ]}
          rows={rows}
          rowKey={(row) => row.symbol}
          onRowClick={(row) => toggleWatchlist(row.symbol)}
          emptyMessage="No instruments match filter."
        />
      </div>
    </div>
  );
}
