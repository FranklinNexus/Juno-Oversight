import type { MarketPayload } from "@/lib/market/payload";

/** Keep list order stable (watchlist / catalog order), not re-sorted by live change%. */
export function orderMarketRows(
  rows: MarketPayload[],
  symbolOrder: string[],
): MarketPayload[] {
  const map = new Map(rows.map((row) => [row.symbol, row]));
  const ordered: MarketPayload[] = [];
  for (const symbol of symbolOrder) {
    const row = map.get(symbol);
    if (row) ordered.push(row);
  }
  for (const row of rows) {
    if (!symbolOrder.includes(row.symbol)) ordered.push(row);
  }
  return ordered;
}
