"use client";

import { memo } from "react";
import { cn } from "@/lib/cn";
import { formatPct, formatPrice, formatVolume24h } from "@/lib/format";
import { formatInstrumentDisplay } from "@/lib/market/instrument-display";
import type { MarketPayload } from "@/lib/market/payload";
import { usePopOutSymbol } from "@/hooks/usePopOutSymbol";

type MarketInstrumentRowProps = {
  row: MarketPayload;
  watchlisted: boolean;
  onToggleWatch: () => void;
  onSelect: () => void;
};

export const MarketInstrumentRow = memo(function MarketInstrumentRow({
  row,
  watchlisted,
  onToggleWatch,
  onSelect,
}: MarketInstrumentRowProps) {
  const up = row.changePct >= 0;
  const display = formatInstrumentDisplay(row.symbol, row.market, row.name);
  const popOut = usePopOutSymbol(row.symbol);

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2 py-2.5 border-b border-[var(--border-dim)]",
        "hover:bg-[var(--bg-hover)] transition-colors",
      )}
    >
      <button
        type="button"
        data-popout-handle
        className="shrink-0 w-5 text-[var(--text-muted)] cursor-grab active:cursor-grabbing touch-none"
        aria-label={`拖出 ${row.symbol} 为独立窗口`}
        title="拖动弹出（已存在则置顶）"
        onPointerDown={popOut.onPointerDown}
        onPointerMove={popOut.onPointerMove}
        onPointerUp={popOut.onPointerUp}
      >
        ⠿
      </button>

      <button
        type="button"
        className="flex flex-1 min-w-0 items-center gap-2 text-left"
        onClick={onSelect}
      >
        <span className="shrink-0 w-9 h-9 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-dim)] flex items-center justify-center text-[10px] font-semibold text-[var(--accent-gold)]">
          {display.initials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1">
            <span className="font-mono-numeric text-[13px] text-[var(--text-porcelain)]">
              {display.code}
            </span>
            <span className="text-[11px] text-[var(--text-muted)]">{display.suffix}</span>
          </span>
          <span className="block text-[10px] text-[var(--text-muted)] mt-0.5 truncate">
            {display.name} · 24h {formatVolume24h(row.volume24h, row.currency, row.market)}
          </span>
        </span>
      </button>

      <button type="button" className="shrink-0 text-right min-w-[88px]" onClick={onSelect}>
        <span className="block font-mono-numeric text-[14px] text-[var(--text-porcelain)] leading-tight">
          {formatPrice(row.last, row.market)}
        </span>
        <span className="block text-[10px] text-[var(--text-muted)] mt-0.5">
          {display.fiatLabel}
        </span>
      </button>

      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "shrink-0 min-w-[72px] h-8 px-2 rounded-md font-mono-numeric text-[12px] font-medium",
          up
            ? "bg-[var(--market-up-bg)] text-[var(--market-up-text)]"
            : "bg-[var(--market-down-bg)] text-[var(--market-down-text)]",
        )}
      >
        {formatPct(row.changePct)}
      </button>

      <button
        type="button"
        className={cn(
          "shrink-0 w-7 h-7 text-[15px] leading-none",
          watchlisted ? "text-[var(--accent-gold)]" : "text-[var(--text-muted)]",
        )}
        aria-label={watchlisted ? "移出自选" : "加入自选"}
        title={watchlisted ? "移出自选" : "加入自选"}
        onClick={(event) => {
          event.stopPropagation();
          onToggleWatch();
        }}
      >
        {watchlisted ? "★" : "☆"}
      </button>

      <button
        type="button"
        className="shrink-0 w-6 h-6 text-[var(--text-muted)] hover:text-[var(--accent-gold)]"
        aria-label={`弹出 ${row.symbol} 窗口`}
        title="弹出独立窗口（已存在则置顶）"
        onClick={(event) => {
          event.stopPropagation();
          popOut.popOutNow();
        }}
      >
        ↗
      </button>
    </div>
  );
});
