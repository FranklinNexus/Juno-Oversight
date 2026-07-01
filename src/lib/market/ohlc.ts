export type ChartTimeframe = "1m" | "15m" | "1h" | "4h" | "1d";

export type OhlcBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const TIMEFRAME_BARS: Record<ChartTimeframe, number> = {
  "1m": 120,
  "15m": 96,
  "1h": 72,
  "4h": 60,
  "1d": 90,
};

const TIMEFRAME_SECONDS: Record<ChartTimeframe, number> = {
  "1m": 60,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

function seedFromSymbol(symbol: string): number {
  let hash = 0;
  for (let i = 0; i < symbol.length; i += 1) {
    hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  }
  return hash || 1;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateOhlcSeries(
  symbol: string,
  timeframe: ChartTimeframe,
  lastPrice: number,
): OhlcBar[] {
  const count = TIMEFRAME_BARS[timeframe];
  const step = TIMEFRAME_SECONDS[timeframe];
  const rand = mulberry32(seedFromSymbol(`${symbol}:${timeframe}`));
  const now = Math.floor(Date.now() / 1000);
  const aligned = now - (now % step);

  let price = lastPrice > 0 ? lastPrice : 100;
  const bars: OhlcBar[] = [];

  for (let i = count - 1; i >= 0; i -= 1) {
    const time = aligned - i * step;
    const drift = (rand() - 0.48) * price * 0.008;
    const open = price;
    const close = Math.max(0.0001, open + drift);
    const wick = Math.abs(drift) + price * (0.002 + rand() * 0.006);
    const high = Math.max(open, close) + wick * rand();
    const low = Math.max(0.0001, Math.min(open, close) - wick * rand());
    const volume = 500_000 + rand() * 4_500_000;
    bars.push({
      time,
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      volume: Number(volume.toFixed(0)),
    });
    price = close;
  }

  if (bars.length > 0 && lastPrice > 0) {
    const last = bars[bars.length - 1];
    last.close = lastPrice;
    last.high = Math.max(last.high, lastPrice);
    last.low = Math.min(last.low, lastPrice);
  }

  return bars;
}
