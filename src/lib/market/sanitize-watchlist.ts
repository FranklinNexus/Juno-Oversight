import {
  DEFAULT_WATCHLIST,
  getInstrument,
} from "@/lib/market/catalog";

export const WATCHLIST_MAX = 24;

export function sanitizeWatchlist(watchlist: unknown): string[] {
  if (!Array.isArray(watchlist)) return [...DEFAULT_WATCHLIST];
  const valid = watchlist.filter(
    (symbol): symbol is string =>
      typeof symbol === "string" && Boolean(getInstrument(symbol)),
  );
  const unique = [...new Set(valid)].slice(0, WATCHLIST_MAX);
  return unique.length > 0 ? unique : [...DEFAULT_WATCHLIST];
}

export function sanitizeSelectedSymbol(
  selectedSymbol: unknown,
  watchlist: string[],
): string {
  if (typeof selectedSymbol === "string" && watchlist.includes(selectedSymbol)) {
    return selectedSymbol;
  }
  return watchlist[0];
}
