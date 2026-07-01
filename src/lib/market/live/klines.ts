import type { ChartTimeframe, OhlcBar } from "@/lib/market/ohlc";
import { getInstrument } from "@/lib/market/catalog";
import { toBinanceSymbol } from "@/lib/market/provider-symbols";

const BINANCE_INTERVAL: Record<ChartTimeframe, string> = {
  "1m": "1m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

const BINANCE_LIMIT: Record<ChartTimeframe, number> = {
  "1m": 120,
  "15m": 96,
  "1h": 72,
  "4h": 60,
  "1d": 90,
};

const YAHOO_INTERVAL: Record<ChartTimeframe, string> = {
  "1m": "1m",
  "15m": "15m",
  "1h": "1h",
  "4h": "1h",
  "1d": "1d",
};

const YAHOO_RANGE: Record<ChartTimeframe, string> = {
  "1m": "1d",
  "15m": "5d",
  "1h": "1mo",
  "4h": "3mo",
  "1d": "1y",
};

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

function binanceKlineToBar(row: BinanceKline): OhlcBar {
  return {
    time: Math.floor(row[0] / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

export async function fetchLiveOhlcSeries(
  symbol: string,
  timeframe: ChartTimeframe,
): Promise<OhlcBar[] | null> {
  const inst = getInstrument(symbol);
  if (!inst) return null;

  if (inst.market === "crypto") {
    const pair = toBinanceSymbol(symbol);
    if (!pair) return null;
    const interval = BINANCE_INTERVAL[timeframe];
    const limit = BINANCE_LIMIT[timeframe];
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
      { next: { revalidate: 0 } },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as BinanceKline[];
    return rows.map(binanceKlineToBar);
  }

  const interval = YAHOO_INTERVAL[timeframe];
  const range = YAHOO_RANGE[timeframe];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "JunoOversight/1.0" },
    next: { revalidate: 0 },
  });
  if (!res.ok) return null;

  const json = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ open?: number[]; high?: number[]; low?: number[]; close?: number[]; volume?: number[] }> };
      }>;
    };
  };

  const result = json.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote) return null;

  const bars: OhlcBar[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    const volume = quote.volume?.[i];
    if (open == null || high == null || low == null || close == null) continue;
    bars.push({
      time: timestamps[i],
      open,
      high,
      low,
      close,
      volume: volume ?? 0,
    });
  }

  return bars.length > 0 ? bars : null;
}
