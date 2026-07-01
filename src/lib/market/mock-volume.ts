/** Stable mock 24h notional per symbol for list subtitles. */
export function mockNotional24h(symbol: string): number {
  let hash = 0;
  for (let i = 0; i < symbol.length; i += 1) {
    hash = (hash + symbol.charCodeAt(i) * (i + 1)) % 997;
  }
  return 4.2e7 + hash * 8.5e5;
}
