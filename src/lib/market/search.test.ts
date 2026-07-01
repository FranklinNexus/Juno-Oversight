import { describe, expect, it } from "vitest";
import { searchInstruments } from "@/lib/market/search";

describe("searchInstruments", () => {
  it("finds crypto and us symbols by query", () => {
    const btc = searchInstruments("btc");
    expect(btc.some((item) => item.symbol === "BTC-USDT")).toBe(true);

    const nvda = searchInstruments("nvidia");
    expect(nvda.some((item) => item.symbol === "NVDA")).toBe(true);
  });

  it("filters by market class", () => {
    const usOnly = searchInstruments("", { market: "us" });
    expect(usOnly.every((item) => item.market === "us")).toBe(true);
  });

  it("finds instruments by localized name", () => {
    const hits = searchInstruments("腾讯");
    expect(hits.some((item) => item.symbol === "0700.HK")).toBe(true);
  });
});
