import type { BookLevel } from "@/lib/market/payload";
import { instrumentFor } from "@/lib/market/provider-symbols";

type YahooQuote = {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
};

type YahooQuoteResponse = {
  quoteResponse?: { result?: YahooQuote[] };
};

function syntheticBook(mid: number): { bids: BookLevel[]; asks: BookLevel[] } {
  const bids: BookLevel[] = [];
  const asks: BookLevel[] = [];
  for (let i = 0; i < 5; i += 1) {
    const step = (i + 1) * (mid * 0.0008);
    bids.push({ price: Number((mid - step).toFixed(4)), size: 100 + i * 50 });
    asks.push({ price: Number((mid + step).toFixed(4)), size: 100 + i * 50 });
  }
  return { bids, asks };
}

export async function fetchYahooQuotes(
  symbols: string[],
): Promise<Map<string, YahooQuote>> {
  if (symbols.length === 0) return new Map();

  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "JunoOversight/1.0" },
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`Yahoo quote ${res.status}`);

  const json = (await res.json()) as YahooQuoteResponse;
  const rows = json.quoteResponse?.result ?? [];
  const out = new Map<string, YahooQuote>();
  for (const row of rows) {
    if (row.symbol) out.set(row.symbol, row);
  }
  return out;
}

export function yahooToPayload(
  symbol: string,
  quote: YahooQuote,
  history: number[] = [],
): import("@/lib/market/payload").MarketPayload | null {
  const inst = instrumentFor(symbol);
  if (!inst) return null;

  const last = quote.regularMarketPrice ?? 0;
  const changePct = quote.regularMarketChangePercent ?? 0;
  const book = syntheticBook(last);

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
    alert: Math.abs(changePct) > 4,
    bids: book.bids,
    asks: book.asks,
    history: history.length ? history : [last],
    volume24h: quote.regularMarketVolume,
    source: "live",
  };
}
