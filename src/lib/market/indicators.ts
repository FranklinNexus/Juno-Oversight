import type { OhlcBar } from "@/lib/market/ohlc";

export type MaPoint = { time: number; value: number };

export type MacdPoint = {
  time: number;
  macd: number;
  signal: number;
  hist: number;
};

export function emaSeries(bars: OhlcBar[], period: number): MaPoint[] {
  if (bars.length === 0 || period < 1) return [];
  const k = 2 / (period + 1);
  let prev = bars[0].close;
  const out: MaPoint[] = [{ time: bars[0].time, value: prev }];

  for (let i = 1; i < bars.length; i += 1) {
    const close = bars[i].close;
    prev = close * k + prev * (1 - k);
    if (i >= period - 1) {
      out.push({ time: bars[i].time, value: Number(prev.toFixed(4)) });
    }
  }
  return out;
}

export function macdSeries(
  bars: OhlcBar[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdPoint[] {
  if (bars.length < slow + signalPeriod) return [];

  const closes = bars.map((b) => b.close);
  const emaFast = emaFromCloses(closes, fast);
  const emaSlow = emaFromCloses(closes, slow);
  const macdLine: number[] = closes.map((_, i) => emaFast[i] - emaSlow[i]);

  const signalLine = emaFromValues(macdLine, signalPeriod);
  const out: MacdPoint[] = [];

  for (let i = 0; i < bars.length; i += 1) {
    if (Number.isNaN(macdLine[i]) || Number.isNaN(signalLine[i])) continue;
    const hist = macdLine[i] - signalLine[i];
    out.push({
      time: bars[i].time,
      macd: Number(macdLine[i].toFixed(4)),
      signal: Number(signalLine[i].toFixed(4)),
      hist: Number(hist.toFixed(4)),
    });
  }
  return out;
}

function emaFromCloses(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = closes[0];
  for (let i = 0; i < closes.length; i += 1) {
    if (i === 0) {
      out.push(prev);
      continue;
    }
    prev = closes[i] * k + prev * (1 - k);
    out.push(i >= period - 1 ? prev : NaN);
  }
  return out;
}

function emaFromValues(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = 0;
  let started = false;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (Number.isNaN(v)) {
      out.push(NaN);
      continue;
    }
    if (!started) {
      prev = v;
      started = true;
      out.push(NaN);
      continue;
    }
    prev = v * k + prev * (1 - k);
    out.push(i >= period ? prev : NaN);
  }
  return out;
}

export function lastMaValues(bars: OhlcBar[]) {
  const ma7 = emaSeries(bars, 7);
  const ma25 = emaSeries(bars, 25);
  const ma99 = emaSeries(bars, 99);
  return {
    ma7: ma7.at(-1)?.value,
    ma25: ma25.at(-1)?.value,
    ma99: ma99.at(-1)?.value,
  };
}
