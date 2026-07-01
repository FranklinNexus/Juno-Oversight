import type { BookLevel } from "@/lib/market/payload";
import { instrumentFor, toBinanceSymbol } from "@/lib/market/provider-symbols";

const BINANCE_API = "https://api.binance.com/api/v3";

type BinanceTicker = {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
};

type BinanceDepth = {
  bids: [string, string][];
  asks: [string, string][];
};

export async function fetchBinanceTickers(
  symbols: string[],
): Promise<Map<string, BinanceTicker>> {
  const pairs = symbols
    .map((s) => toBinanceSymbol(s))
    .filter((s): s is string => Boolean(s));
  if (pairs.length === 0) return new Map();

  const url =
    pairs.length === 1
      ? `${BINANCE_API}/ticker/24hr?symbol=${pairs[0]}`
      : `${BINANCE_API}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(pairs))}`;

  const res = await fetch(url, { next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`Binance ticker ${res.status}`);
  const json = (await res.json()) as BinanceTicker | BinanceTicker[];
  const list = Array.isArray(json) ? json : [json];
  const byPair = new Map(list.map((row) => [row.symbol, row]));

  const out = new Map<string, BinanceTicker>();
  for (const symbol of symbols) {
    const pair = toBinanceSymbol(symbol);
    if (!pair) continue;
    const row = byPair.get(pair);
    if (row) out.set(symbol, row);
  }
  return out;
}

export async function fetchBinanceDepth(symbol: string, limit = 8): Promise<{
  bids: BookLevel[];
  asks: BookLevel[];
}> {
  const pair = toBinanceSymbol(symbol);
  if (!pair) return { bids: [], asks: [] };

  const res = await fetch(
    `${BINANCE_API}/depth?symbol=${pair}&limit=${limit}`,
    { next: { revalidate: 0 } },
  );
  if (!res.ok) throw new Error(`Binance depth ${res.status}`);
  const json = (await res.json()) as BinanceDepth;

  const mapSide = (rows: [string, string][]): BookLevel[] =>
    rows.map(([price, size]) => ({
      price: Number(price),
      size: Number(size),
    }));

  return { bids: mapSide(json.bids), asks: mapSide(json.asks) };
}

export function tickerToPayload(
  symbol: string,
  ticker: BinanceTicker,
  depth?: { bids: BookLevel[]; asks: BookLevel[] },
  history: number[] = [],
): import("@/lib/market/payload").MarketPayload | null {
  const inst = instrumentFor(symbol);
  if (!inst) return null;

  const last = Number(ticker.lastPrice);
  const changePct = Number(ticker.priceChangePercent);
  const volume24h = Number(ticker.quoteVolume);

  return {
    id: symbol,
    timestamp: Date.now(),
    symbol,
    market: inst.market,
    name: inst.nameLocal ?? inst.name,
    currency: inst.currency,
    last,
    changePct,
    volatility: Math.abs(changePct) / 24,
    alert: Math.abs(changePct) > 5,
    bids: depth?.bids ?? [],
    asks: depth?.asks ?? [],
    history: history.length ? history : [last],
    volume24h,
    source: "live",
  };
}
