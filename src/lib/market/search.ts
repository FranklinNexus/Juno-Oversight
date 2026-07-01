import {
  INSTRUMENT_CATALOG,
  MARKET_LABELS,
  type Instrument,
  type MarketClass,
} from "@/lib/market/catalog";

export type InstrumentSearchResult = Instrument & {
  subtitle: string;
};

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, "");
}

export function searchInstruments(
  query: string,
  options?: { market?: MarketClass | "all"; limit?: number },
): InstrumentSearchResult[] {
  const q = normalizeQuery(query);
  const market = options?.market ?? "all";
  const limit = options?.limit ?? 24;

  let base =
    market === "all"
      ? INSTRUMENT_CATALOG
      : INSTRUMENT_CATALOG.filter((item) => item.market === market);

  if (q) {
    base = base.filter((item) => {
      const hay = [
        item.symbol,
        item.name,
        item.nameLocal ?? "",
        item.displayCode ?? "",
        MARKET_LABELS[item.market],
      ]
        .join("")
        .toLowerCase();
      const compactSymbol = item.symbol.toLowerCase().replace(/[-.]/g, "");
      return hay.includes(q) || compactSymbol.includes(q);
    });
  }

  return base.slice(0, limit).map((item) => ({
    ...item,
    subtitle: [item.nameLocal ?? item.name, MARKET_LABELS[item.market]].join(" · "),
  }));
}
