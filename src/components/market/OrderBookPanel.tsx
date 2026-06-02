"use client";

import { formatPrice } from "@/lib/format";
import type { BookLevel } from "@/mocks/generators/market-feed";

function DepthRow({
  price,
  size,
  maxSize,
  side,
  market,
}: {
  price: number;
  size: number;
  maxSize: number;
  side: "bid" | "ask";
  market: string;
}) {
  const widthPct = maxSize > 0 ? (size / maxSize) * 100 : 0;
  const barColor = side === "bid" ? "var(--depth-bid)" : "var(--depth-ask)";

  return (
    <div className="relative grid grid-cols-[1fr_auto] gap-2 py-[1px]">
      <div
        className="absolute inset-y-0 opacity-30"
        style={{
          width: `${widthPct}%`,
          background: barColor,
          right: side === "bid" ? 0 : undefined,
          left: side === "ask" ? 0 : undefined,
        }}
      />
      <span className="relative font-mono-numeric text-[11px] text-[var(--text-porcelain)]">
        {formatPrice(price, market)}
      </span>
      <span className="relative font-mono-numeric text-[11px] text-[var(--text-muted)]">
        {size.toFixed(3)}
      </span>
    </div>
  );
}

type OrderBookPanelProps = {
  symbol: string;
  market: string;
  bids: BookLevel[];
  asks: BookLevel[];
};

export function OrderBookPanel({ symbol, market, bids, asks }: OrderBookPanelProps) {
  const maxSize = Math.max(
    ...bids.map((level) => level.size),
    ...asks.map((level) => level.size),
    0.001,
  );

  return (
    <div className="h-full flex flex-col">
      <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
        Order Book / {symbol}
      </div>
      <div className="flex-1 grid grid-cols-2 gap-3 min-h-0">
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--bid)] mb-1">Bids</div>
          {bids.map((level) => (
            <DepthRow
              key={`bid-${level.price}`}
              price={level.price}
              size={level.size}
              maxSize={maxSize}
              side="bid"
              market={market}
            />
          ))}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--ask)] mb-1">Asks</div>
          {asks.map((level) => (
            <DepthRow
              key={`ask-${level.price}`}
              price={level.price}
              size={level.size}
              maxSize={maxSize}
              side="ask"
              market={market}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
