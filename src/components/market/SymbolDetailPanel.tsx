"use client";

import { useMemo, useState } from "react";
import { MarketTradingChart, type ChartMode } from "@/components/market/MarketTradingChart";
import { OrderBookPanel } from "@/components/market/OrderBookPanel";
import { EmptyState, HudSegment, LoadingRows } from "@/components/ui";
import { useElementHeight } from "@/hooks/useElementHeight";
import { useMarketFeed } from "@/hooks/useMarketFeed";
import { cn } from "@/lib/cn";
import { formatPct, formatPrice } from "@/lib/format";
import { getInstrument } from "@/lib/market/catalog";
import { formatInstrumentDisplay } from "@/lib/market/instrument-display";
import type { ChartTimeframe } from "@/lib/market/ohlc";
import {
  resolveSymbolDetailLayout,
  SYMBOL_DETAIL_LAYOUT,
} from "@/lib/market/symbol-detail-layout";
import { useHudStore } from "@/store/hud-store";
import { useMarketStore } from "@/store/market-store";

type SymbolDetailPanelProps = {
  symbol: string;
};

const TIMEFRAMES: Array<{ id: ChartTimeframe; label: string }> = [
  { id: "1m", label: "1m" },
  { id: "15m", label: "15m" },
  { id: "1h", label: "1H" },
  { id: "4h", label: "4H" },
  { id: "1d", label: "1D" },
];

const CHART_MODES: Array<{ id: ChartMode; label: string }> = [
  { id: "line", label: "分时" },
  { id: "candle", label: "K线" },
];

export function SymbolDetailPanel({ symbol }: SymbolDetailPanelProps) {
  const mode = useHudStore((state) => state.mode);
  const wsConnected = useHudStore((state) => state.wsConnected);
  const watchlist = useMarketStore((state) => state.watchlist);
  const toggleWatchlist = useMarketStore((state) => state.toggleWatchlist);

  const [timeframe, setTimeframe] = useState<ChartTimeframe>("15m");
  const [chartMode, setChartMode] = useState<ChartMode>("candle");
  const { ref: bodyRef, height: bodyHeight } = useElementHeight();
  const layout = useMemo(() => resolveSymbolDetailLayout(bodyHeight), [bodyHeight]);

  const feedSymbols = useMemo(() => [symbol], [symbol]);
  const { rows: incoming, source: feedSource, error: feedError } = useMarketFeed(feedSymbols);

  const row = incoming?.find((item) => item.symbol === symbol);
  const up = (row?.changePct ?? 0) >= 0;
  const watchlisted = watchlist.includes(symbol);
  const catalog = getInstrument(symbol);
  const display = row
    ? formatInstrumentDisplay(row.symbol, row.market, row.name)
    : formatInstrumentDisplay(
        symbol,
        catalog?.market ?? "us",
        catalog?.nameLocal ?? catalog?.name,
      );

  const bids = row ? (mode === "focus" ? row.bids.slice(0, 5) : row.bids.slice(0, 8)) : [];
  const asks = row ? (mode === "focus" ? row.asks.slice(0, 5) : row.asks.slice(0, 8)) : [];

  return (
    <div className="h-full min-h-0 flex flex-col bg-[var(--bg-panel)] overflow-hidden">
      <div className="shrink-0 px-3 py-2 border-b border-[var(--border-dim)]">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex items-center gap-2">
            <h2 className="font-mono-numeric text-[17px] text-[var(--text-porcelain)]">
              {display.code}
              <span className="text-[12px] text-[var(--text-muted)] ml-1">{display.suffix}</span>
            </h2>
            <button
              type="button"
              className={cn(
                "text-[15px]",
                watchlisted ? "text-[var(--accent-gold)]" : "text-[var(--text-muted)]",
              )}
              onClick={() => toggleWatchlist(symbol)}
              aria-label={watchlisted ? "移出自选" : "加入自选"}
            >
              {watchlisted ? "★" : "☆"}
            </button>
          </div>
          <span className="text-[9px] text-[var(--text-muted)]">
            {feedSource === "live" ? "LIVE" : "MOCK"} · {wsConnected ? "ON" : "OFF"}
          </span>
        </div>
        <p className="text-[11px] text-[var(--text-muted)] truncate">{display.name}</p>

        {row && (
          <div className="mt-2 flex items-end justify-between">
            <div>
              <div
                className={cn(
                  "font-mono-numeric text-[26px] leading-none",
                  up ? "text-[var(--market-up-text)]" : "text-[var(--market-down-text)]",
                )}
              >
                {formatPrice(row.last, row.market)}
              </div>
              <div className="text-[11px] text-[var(--text-muted)] mt-1">
                {display.fiatLabel} · 24h {formatPct(row.changePct)}
              </div>
            </div>
            <span
              className={cn(
                "px-3 py-1.5 rounded-lg font-mono-numeric text-[14px] font-medium",
                up
                  ? "bg-[var(--market-up-bg)] text-[var(--market-up-text)]"
                  : "bg-[var(--market-down-bg)] text-[var(--market-down-text)]",
              )}
            >
              {formatPct(row.changePct)}
            </span>
          </div>
        )}
      </div>

      <div className="shrink-0 px-2 py-1 border-b border-[var(--border-dim)] flex flex-wrap items-center gap-2">
        <HudSegment value={chartMode} options={CHART_MODES} onChange={setChartMode} />
        <HudSegment value={timeframe} options={TIMEFRAMES} onChange={setTimeframe} />
      </div>

      {feedError && feedSource === "live" && (
        <p className="shrink-0 px-3 py-1 text-[10px] text-[var(--market-down-text)] border-b border-[var(--border-dim)]">
          行情：{feedError}
        </p>
      )}

      {!row && <LoadingRows rows={8} className="p-2 flex-1" />}

      {row && (
        <div ref={bodyRef} className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0 overflow-hidden">
            <MarketTradingChart
              symbol={symbol}
              timeframe={timeframe}
              mode={chartMode}
              lastPrice={row.last}
              showLegend={layout.showLegend}
              showMacd={layout.showMacd}
            />
          </div>

          {layout.showOrderBook && (
            <div
              className="shrink-0 overflow-hidden border-t border-[var(--border-dim)]"
              style={{ height: SYMBOL_DETAIL_LAYOUT.bookPanel }}
            >
              <div className="h-full p-2">
                <OrderBookPanel
                  symbol={row.symbol}
                  market={row.market}
                  bids={bids}
                  asks={asks}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {incoming && !row && <EmptyState message="等待行情推送…" />}
    </div>
  );
}
