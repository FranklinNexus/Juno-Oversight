"use client";

import { useMemo } from "react";
import { MarketInstrumentRow } from "@/components/market/MarketInstrumentRow";
import { MarketSearchOverlay } from "@/components/market/MarketSearchOverlay";
import { EmptyState, HudSegment, LoadingRows } from "@/components/ui";
import { useFocusSymbol } from "@/hooks/useFocusSymbol";
import { useMarketFeed } from "@/hooks/useMarketFeed";
import { INSTRUMENT_CATALOG, MARKET_LABELS } from "@/lib/market/catalog";
import { orderMarketRows } from "@/lib/market/list-order";
import { useHudStore } from "@/store/hud-store";
import { useMarketStore, type MarketHubTab } from "@/store/market-store";

const HUB_TABS: Array<{ id: MarketHubTab; label: string }> = [
  { id: "watchlist", label: "自选" },
  { id: "all", label: "全部" },
  { id: "crypto", label: MARKET_LABELS.crypto },
  { id: "us", label: MARKET_LABELS.us },
  { id: "hk", label: MARKET_LABELS.hk },
  { id: "cn_a", label: MARKET_LABELS.cn_a },
];

function symbolsForTab(tab: MarketHubTab, watchlist: string[]): string[] {
  if (tab === "watchlist") return watchlist;
  if (tab === "all") return INSTRUMENT_CATALOG.map((item) => item.symbol);
  return INSTRUMENT_CATALOG.filter((item) => item.market === tab).map((item) => item.symbol);
}

export function MarketHubPanel() {
  const wsConnected = useHudStore((state) => state.wsConnected);
  const hubTab = useMarketStore((state) => state.hubTab);
  const setHubTab = useMarketStore((state) => state.setHubTab);
  const watchlist = useMarketStore((state) => state.watchlist);
  const toggleWatchlist = useMarketStore((state) => state.toggleWatchlist);
  const focusSymbol = useFocusSymbol();
  const setSearchOpen = useMarketStore((state) => state.setSearchOpen);

  const symbols = useMemo(() => symbolsForTab(hubTab, watchlist), [hubTab, watchlist]);
  const { rows: incoming, error: feedError, source: feedSource } = useMarketFeed(symbols);

  const rows = useMemo(() => {
    if (!incoming) return [];
    return orderMarketRows(incoming, symbols);
  }, [incoming, symbols]);

  return (
    <div className="relative h-full min-h-0 flex flex-col bg-[var(--bg-panel)]">
      <button
        type="button"
        className="shrink-0 mx-2 mt-2 mb-1 flex items-center gap-2 h-9 px-3 rounded-lg border border-[var(--border-dim)] bg-[var(--bg-elevated)] text-left text-[var(--text-muted)] hover:border-[var(--border-strong)]"
        onClick={() => setSearchOpen(true)}
      >
        <span className="text-sm">⌕</span>
        <span className="text-[12px]">搜索币种 / 股票</span>
      </button>

      <div className="shrink-0 px-2 pb-1 overflow-x-auto hud-scroll">
        <HudSegment value={hubTab} options={HUB_TABS} onChange={setHubTab} />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto hud-scroll border-t border-[var(--border-dim)]">
        {feedError && feedSource === "live" && (
          <p className="px-2 py-1 text-[10px] text-[var(--market-down-text)] border-b border-[var(--border-dim)]">
            行情拉取失败：{feedError}（可切 MOCK 或检查网络）
          </p>
        )}
        {!incoming && <LoadingRows rows={6} className="p-2" />}
        {incoming && rows.length === 0 && (
          <EmptyState
            message={
              hubTab === "watchlist"
                ? "自选为空。搜索并点击 ★ 添加标的。"
                : "该分类暂无标的。"
            }

          />
        )}
        {incoming &&
          rows.map((row) => (
            <MarketInstrumentRow
              key={row.symbol}
              row={row}
              watchlisted={watchlist.includes(row.symbol)}
              onToggleWatch={() => toggleWatchlist(row.symbol)}
              onSelect={() => focusSymbol(row.symbol)}
            />
          ))}
      </div>

      <div className="shrink-0 px-2 py-1 border-t border-[var(--border-dim)] flex items-center justify-between text-[9px] text-[var(--text-muted)] uppercase tracking-[0.08em]">
        <span>{hubTab === "watchlist" ? `自选 ${watchlist.length}` : HUB_TABS.find((t) => t.id === hubTab)?.label}</span>
        <span>
          {feedSource === "live" ? "BINANCE·YAHOO" : "MOCK"} · {wsConnected ? "ON" : "OFF"}
        </span>
      </div>

      <MarketSearchOverlay />
    </div>
  );
}
