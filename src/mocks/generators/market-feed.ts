import { getInstrument } from "@/lib/market/catalog";

export type BookLevel = {
  price: number;
  size: number;
};

export type MarketPayload = {
  id: string;
  timestamp: number;
  symbol: string;
  market: "crypto" | "us" | "hk" | "cn_a";
  name: string;
  currency: string;
  last: number;
  changePct: number;
  volatility: number;
  alert: boolean;
  bids: BookLevel[];
  asks: BookLevel[];
  history: number[];
};

const lastPrices = new Map<string, number>();
const histories = new Map<string, number[]>();

function jitter(base: number, pct: number): number {
  return base * (1 + (Math.random() - 0.5) * pct);
}

function makeBook(mid: number) {
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  for (let i = 0; i < 5; i += 1) {
    const step = (i + 1) * (mid * 0.0006);
    bids.push({
      price: Number((mid - step).toFixed(4)),
      size: Number((Math.random() * 6 + 0.2).toFixed(3)),
    });
    asks.push({
      price: Number((mid + step).toFixed(4)),
      size: Number((Math.random() * 6 + 0.2).toFixed(3)),
    });
  }
  return { bids, asks };
}

function pushHistory(symbol: string, value: number) {
  const prev = histories.get(symbol) ?? [];
  const next = [...prev, value].slice(-32);
  histories.set(symbol, next);
  return next;
}

export function generateMarketBatch(watchlist: string[]): MarketPayload[] {
  return watchlist
    .map((symbol) => {
      const instrument = getInstrument(symbol);
      if (!instrument) return null;

      const base = instrument.basePrice;
      const prev = lastPrices.get(symbol) ?? base;
      const next = jitter(prev, 0.012);
      const changePct = ((next - base) / base) * 100;
      const volatility = Math.abs(((next - prev) / prev) * 100);
      lastPrices.set(symbol, next);

      const { bids, asks } = makeBook(next);
      const history = pushHistory(symbol, next);

      return {
        id: `${symbol}-${Date.now()}`,
        timestamp: Date.now(),
        symbol,
        market: instrument.market,
        name: instrument.name,
        currency: instrument.currency,
        last: Number(next.toFixed(4)),
        changePct: Number(changePct.toFixed(2)),
        volatility: Number(volatility.toFixed(3)),
        alert: volatility > 0.45,
        bids,
        asks,
        history,
      };
    })
    .filter((row): row is MarketPayload => row !== null);
}
