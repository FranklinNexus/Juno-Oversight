import { describe, expect, it } from "vitest";
import { emaSeries, macdSeries } from "@/lib/market/indicators";
import type { OhlcBar } from "@/lib/market/ohlc";

function mockBars(n: number): OhlcBar[] {
  const bars: OhlcBar[] = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    price += Math.sin(i / 3) * 2;
    bars.push({
      time: 1_700_000_000 + i * 60,
      open: price,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 1_000_000,
    });
  }
  return bars;
}

describe("indicators", () => {
  it("produces MA series", () => {
    const ma = emaSeries(mockBars(40), 7);
    expect(ma.length).toBeGreaterThan(30);
  });

  it("produces MACD series", () => {
    const macd = macdSeries(mockBars(80));
    expect(macd.length).toBeGreaterThan(40);
  });
});
