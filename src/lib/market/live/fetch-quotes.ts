import type { MarketPayload } from "@/lib/market/payload";
import { getInstrument } from "@/lib/market/catalog";
import { splitSymbolsByProvider } from "@/lib/market/provider-symbols";
import { fetchBinanceDepth, fetchBinanceTickers, tickerToPayload } from "@/lib/market/live/binance";
import { fetchYahooQuotes, yahooToPayload } from "@/lib/market/live/yahoo";

const priceHistory = new Map<string, number[]>();

function pushHistory(symbol: string, price: number): number[] {
  const prev = priceHistory.get(symbol) ?? [];
  const next = [...prev, price].slice(-32);
  priceHistory.set(symbol, next);
  return next;
}

/**
 * Server-side aggregator: Binance (crypto) + Yahoo (US/HK/A).
 * Depth fetched for crypto when ≤3 symbols (detail / small lists).
 */
export async function fetchLiveMarketBatch(symbols: string[]): Promise<MarketPayload[]> {
  const unique = [...new Set(symbols)].filter((s) => getInstrument(s));
  if (unique.length === 0) return [];

  const { binance, yahoo } = splitSymbolsByProvider(unique);
  const out: MarketPayload[] = [];

  const [binanceTickers, yahooQuotes] = await Promise.all([
    fetchBinanceTickers(binance).catch(() => new Map()),
    fetchYahooQuotes(yahoo).catch(() => new Map()),
  ]);

  const fetchDepth = binance.length <= 3;
  for (const symbol of binance) {
    const ticker = binanceTickers.get(symbol);
    if (!ticker) continue;
    const last = Number(ticker.lastPrice);
    const history = pushHistory(symbol, last);
    const depth = fetchDepth ? await fetchBinanceDepth(symbol).catch(() => undefined) : undefined;
    const row = tickerToPayload(symbol, ticker, depth, history);
    if (row) out.push(row);
  }

  for (const symbol of yahoo) {
    const quote = yahooQuotes.get(symbol);
    if (!quote) continue;
    const last = quote.regularMarketPrice ?? 0;
    const history = pushHistory(symbol, last);
    const row = yahooToPayload(symbol, quote, history);
    if (row) out.push(row);
  }

  return out;
}
