"use client";

import { memo, useCallback, useMemo } from "react";
import { OrderBookPanel } from "@/components/market/OrderBookPanel";
import { WatchlistPicker } from "@/components/market/WatchlistPicker";
import { WidgetShell } from "@/components/dashboard/WidgetShell";
import { EmptyState, HudButton, HudSegment, LoadingRows, Sparkline } from "@/components/ui";
import { useMockWebSocket } from "@/hooks/useMockWebSocket";
import { cn } from "@/lib/cn";
import { formatPct, formatPrice } from "@/lib/format";
import { MARKET_LABELS, type MarketClass } from "@/lib/market/catalog";
import {
  generateMarketBatch,
  type MarketPayload,
} from "@/mocks/generators/market-feed";
import { useHudStore } from "@/store/hud-store";
import { useMarketStore } from "@/store/market-store";

const TickerRow = memo(function TickerRow({
  row,
  selected,
  onSelect,
}: {
  row: MarketPayload;
  selected: boolean;
  onSelect: (symbol: string) => void;
}) {
  const up = row.changePct >= 0;

  return (
    <button
      type="button"
      onClick={() => onSelect(row.symbol)}
      className={cn(
        "text-left min-w-[168px] border px-2 py-1",
        row.alert
          ? "border-[var(--accent-gold)]"
          : selected
            ? "border-[var(--border-strong)]"
            : "border-[var(--border-dim)]",
        selected ? "bg-[var(--bg-hover)]" : "bg-transparent",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono-numeric text-[11px]">{row.symbol}</span>
        <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
          {MARKET_LABELS[row.market]}
        </span>
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div>
          <div className="font-mono-numeric text-[11px] text-[var(--text-porcelain)]">
            {formatPrice(row.last, row.market)} {row.currency}
          </div>
          <div
            className={cn(
              "font-mono-numeric text-[10px]",
              row.alert
                ? "text-[var(--accent-gold)]"
                : up
                  ? "text-[var(--up)]"
                  : "text-[var(--down)]",
            )}
          >
            {formatPct(row.changePct)}
          </div>
        </div>
        <Sparkline values={row.history} alert={row.alert} />
      </div>
    </button>
  );
});

export function AlphaMarketIngestor() {
  const mode = useHudStore((state) => state.mode);
  const wsConnected = useHudStore((state) => state.wsConnected);
  const marketFilter = useMarketStore((state) => state.marketFilter);
  const selectedSymbol = useMarketStore((state) => state.selectedSymbol);
  const setSelectedSymbol = useMarketStore((state) => state.setSelectedSymbol);
  const setPickerOpen = useMarketStore((state) => state.setPickerOpen);
  const setMarketFilter = useMarketStore((state) => state.setMarketFilter);

  const marketTabs = useMemo(
    () =>
      [
        { id: "all" as const, label: "ALL" },
        { id: "crypto" as const, label: MARKET_LABELS.crypto },
        { id: "us" as const, label: MARKET_LABELS.us },
        { id: "hk" as const, label: MARKET_LABELS.hk },
        { id: "cn_a" as const, label: MARKET_LABELS.cn_a },
      ] satisfies Array<{ id: MarketClass | "all"; label: string }>,
    [],
  );

  const generate = useCallback(
    () => generateMarketBatch(useMarketStore.getState().watchlist),
    [],
  );

  const incoming = useMockWebSocket<MarketPayload[]>({
    feedId: "market",
    mode,
    generate,
  });

  const visibleRows = useMemo(() => {
    const rows = incoming ?? [];
    const filtered =
      marketFilter === "all" ? rows : rows.filter((row) => row.market === marketFilter);
    const limit = mode === "focus" ? 4 : 8;
    return filtered.slice(0, limit);
  }, [incoming, marketFilter, mode]);

  const active =
    visibleRows.find((row) => row.symbol === selectedSymbol) ?? visibleRows[0];

  const bids = active ? (mode === "focus" ? active.bids.slice(0, 3) : active.bids.slice(0, 5)) : [];
  const asks = active ? (mode === "focus" ? active.asks.slice(0, 3) : active.asks.slice(0, 5)) : [];

  return (
    <div className="relative h-full min-h-0">
      <WidgetShell
        title="Alpha Market Ingestor"
        code="WIDGET-A"
        live={wsConnected}
        actions={
          <HudButton onClick={() => setPickerOpen(true)}>Watchlist</HudButton>
        }
      >
        <div className="h-full p-2 flex flex-col gap-2 min-h-0">
          <HudSegment value={marketFilter} options={marketTabs} onChange={setMarketFilter} />

          <div className="flex gap-1 overflow-x-auto pb-1 hud-scroll min-h-[52px]">
            {!incoming && <LoadingRows rows={2} className="w-full" />}
            {incoming &&
              visibleRows.map((row) => (
                <TickerRow
                  key={row.symbol}
                  row={row}
                  selected={active?.symbol === row.symbol}
                  onSelect={setSelectedSymbol}
                />
              ))}
            {incoming && visibleRows.length === 0 && (
              <EmptyState message="No symbols in watchlist for this market filter." />
            )}
          </div>

          <div className="flex-1 border border-[var(--border-dim)] p-2 min-h-0">
            {!incoming && <LoadingRows rows={5} />}
            {incoming && active && (
              <OrderBookPanel
                symbol={active.symbol}
                market={active.market}
                bids={bids}
                asks={asks}
              />
            )}
            {incoming && !active && (
              <EmptyState message="Waiting for market feed..." />
            )}
          </div>
        </div>
      </WidgetShell>
      <WatchlistPicker />
    </div>
  );
}
