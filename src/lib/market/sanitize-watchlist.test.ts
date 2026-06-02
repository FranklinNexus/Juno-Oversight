import { describe, expect, it } from "vitest";
import { DEFAULT_WATCHLIST } from "@/lib/market/catalog";
import {
  sanitizeSelectedSymbol,
  sanitizeWatchlist,
} from "@/lib/market/sanitize-watchlist";

describe("sanitizeWatchlist", () => {
  it("drops unknown symbols", () => {
    const result = sanitizeWatchlist(["BTC-USDT", "NOT_REAL", "NVDA"]);
    expect(result).toEqual(["BTC-USDT", "NVDA"]);
  });

  it("falls back to default when empty", () => {
    expect(sanitizeWatchlist([])).toEqual([...DEFAULT_WATCHLIST]);
    expect(sanitizeWatchlist("bad")).toEqual([...DEFAULT_WATCHLIST]);
  });
});

describe("sanitizeSelectedSymbol", () => {
  it("uses first watchlist symbol when selection invalid", () => {
    expect(sanitizeSelectedSymbol("GHOST", ["NVDA", "AAPL"])).toBe("NVDA");
  });
});
