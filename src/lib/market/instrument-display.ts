import { getInstrument, MARKET_LABELS, type MarketClass } from "@/lib/market/catalog";

export type InstrumentDisplay = {
  symbol: string;
  market: MarketClass;
  /** Primary line: ticker code (00700, 600519, BTC) */
  code: string;
  /** Secondary: exchange / quote leg */
  suffix: string;
  /** Full legal or localized name */
  name: string;
  /** Avatar initials */
  initials: string;
  /** Fiat label for price subtitle (HKD, CNY, USD) */
  fiatLabel: string;
};

function hkDisplayCode(symbol: string): string {
  const raw = symbol.replace(/\.HK$/i, "");
  const num = parseInt(raw, 10);
  if (Number.isNaN(num)) return raw;
  return num.toString().padStart(5, "0");
}

function cnDisplayCode(symbol: string): string {
  return symbol.replace(/\.(SS|SZ)$/i, "");
}

export function formatInstrumentDisplay(
  symbol: string,
  market: MarketClass,
  fallbackName?: string,
): InstrumentDisplay {
  const instrument = getInstrument(symbol);
  const name = instrument?.name ?? fallbackName ?? symbol;

  if (market === "crypto" && symbol.includes("-")) {
    const [base, quote] = symbol.split("-");
    return {
      symbol,
      market,
      code: base,
      suffix: `/ ${quote}`,
      name,
      initials: base.slice(0, 2).toUpperCase(),
      fiatLabel: "USD",
    };
  }

  if (market === "hk") {
    const code = instrument?.displayCode ?? hkDisplayCode(symbol);
    return {
      symbol,
      market,
      code,
      suffix: MARKET_LABELS.hk,
      name: instrument?.nameLocal ?? name,
      initials: name.slice(0, 2),
      fiatLabel: "HKD",
    };
  }

  if (market === "cn_a") {
    const code = instrument?.displayCode ?? cnDisplayCode(symbol);
    const exchange = symbol.endsWith(".SZ") ? "SZ" : "SH";
    return {
      symbol,
      market,
      code,
      suffix: exchange,
      name: instrument?.nameLocal ?? name,
      initials: name.slice(0, 2),
      fiatLabel: "CNY",
    };
  }

  return {
    symbol,
    market,
    code: instrument?.displayCode ?? symbol,
    suffix: MARKET_LABELS[market],
    name,
    initials: symbol.slice(0, 2).toUpperCase(),
    fiatLabel: instrument?.currency ?? "USD",
  };
}
