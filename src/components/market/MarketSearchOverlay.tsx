"use client";

import { useMemo, useState } from "react";
import { MarketInstrumentRow } from "@/components/market/MarketInstrumentRow";
import { EmptyState, HudButton, HudInput } from "@/components/ui";
import { useFocusSymbol } from "@/hooks/useFocusSymbol";
import { useMarketFeed } from "@/hooks/useMarketFeed";
import { searchInstruments } from "@/lib/market/search";
import type { MarketPayload } from "@/lib/market/payload";
import { useMarketStore } from "@/store/market-store";

export function MarketSearchOverlay() {
  const searchOpen = useMarketStore((state) => state.searchOpen);
  const setSearchOpen = useMarketStore((state) => state.setSearchOpen);
  const watchlist = useMarketStore((state) => state.watchlist);
  const toggleWatchlist = useMarketStore((state) => state.toggleWatchlist);
  const focusSymbol = useFocusSymbol();

  const [query, setQuery] = useState("");

  const hits = useMemo(() => searchInstruments(query, { limit: 32 }), [query]);
  const symbols = useMemo(() => hits.map((item) => item.symbol), [hits]);
  const { rows: incoming } = useMarketFeed(symbols);

  const rowMap = useMemo(() => {
    const map = new Map<string, MarketPayload>();
    for (const row of incoming ?? []) {
      map.set(row.symbol, row);
    }
    return map;
  }, [incoming]);

  if (!searchOpen) return null;

  const handlePick = (symbol: string) => {
    if (!watchlist.includes(symbol)) toggleWatchlist(symbol);
    focusSymbol(symbol);
    setSearchOpen(false);
    setQuery("");
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-[var(--bg-panel)]">
      <div className="shrink-0 border-b border-[var(--border-dim)] px-2 py-2 flex items-center gap-2">
        <span className="text-[var(--text-muted)] text-sm">⌕</span>
        <HudInput
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索币种 / 美股 / 港股 / A股"
          className="flex-1 max-w-none h-8 text-[13px]"
        />
        <HudButton variant="ghost" onClick={() => setSearchOpen(false)}>
          ✕
        </HudButton>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto hud-scroll">
        {!query.trim() && (
          <p className="px-3 py-2 text-[11px] text-[var(--text-muted)]">
            输入代码或名称，支持 Crypto、美股、港股、A 股
          </p>
        )}
        {query.trim() && hits.length === 0 && (
          <EmptyState message="未找到匹配的标的" />
        )}
        {hits.map((hit) => {
          const row = rowMap.get(hit.symbol);
          if (!row) {
            return (
              <div
                key={hit.symbol}
                className="px-3 py-3 border-b border-[var(--border-dim)] text-[11px] text-[var(--text-muted)]"
              >
                {hit.symbol} · {hit.subtitle}
              </div>
            );
          }
          return (
            <MarketInstrumentRow
              key={hit.symbol}
              row={row}
              watchlisted={watchlist.includes(hit.symbol)}
              onToggleWatch={() => toggleWatchlist(hit.symbol)}
              onSelect={() => handlePick(hit.symbol)}
            />
          );
        })}
      </div>

      <div className="shrink-0 border-t border-[var(--border-dim)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
        点击行打开详情窗 · ⠿ 拖动或 ↗ 同样弹出（已存在则置顶）
      </div>
    </div>
  );
}
