"use client";

import { DepthRow, SectionLabel } from "@/components/ui";
import { formatPrice } from "@/lib/format";
import type { BookLevel } from "@/lib/market/payload";

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
    <div className="h-full flex flex-col min-h-0">
      <SectionLabel>Order Book / {symbol}</SectionLabel>
      <div className="flex-1 grid grid-cols-2 gap-3 min-h-0">
        <div>
          <SectionLabel tone="bid">Bids</SectionLabel>
          {bids.map((level) => (
            <DepthRow
              key={`bid-${level.price}`}
              price={formatPrice(level.price, market)}
              size={level.size.toFixed(3)}
              widthPct={(level.size / maxSize) * 100}
              side="bid"
            />
          ))}
        </div>
        <div>
          <SectionLabel tone="ask">Asks</SectionLabel>
          {asks.map((level) => (
            <DepthRow
              key={`ask-${level.price}`}
              price={formatPrice(level.price, market)}
              size={level.size.toFixed(3)}
              widthPct={(level.size / maxSize) * 100}
              side="ask"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
