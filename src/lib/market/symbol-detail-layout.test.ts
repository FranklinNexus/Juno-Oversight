import { describe, expect, it } from "vitest";
import {
  resolveSymbolDetailLayout,
  SYMBOL_DETAIL_LAYOUT,
} from "@/lib/market/symbol-detail-layout";

describe("resolveSymbolDetailLayout", () => {
  it("shows only chart tier when short", () => {
    const layout = resolveSymbolDetailLayout(200);
    expect(layout.tier).toBe("chart");
    expect(layout.showMacd).toBe(false);
    expect(layout.showOrderBook).toBe(false);
  });

  it("shows indicators before order book", () => {
    const h =
      SYMBOL_DETAIL_LAYOUT.chartMin +
      SYMBOL_DETAIL_LAYOUT.legend +
      SYMBOL_DETAIL_LAYOUT.macdBlock +
      10;
    const layout = resolveSymbolDetailLayout(h);
    expect(layout.tier).toBe("indicators");
    expect(layout.showMacd).toBe(true);
    expect(layout.showOrderBook).toBe(false);
  });

  it("shows full stack when tall enough", () => {
    const h =
      SYMBOL_DETAIL_LAYOUT.chartMin +
      SYMBOL_DETAIL_LAYOUT.legend +
      SYMBOL_DETAIL_LAYOUT.macdBlock +
      SYMBOL_DETAIL_LAYOUT.bookPanel;
    const layout = resolveSymbolDetailLayout(h);
    expect(layout.tier).toBe("full");
    expect(layout.showOrderBook).toBe(true);
  });
});
