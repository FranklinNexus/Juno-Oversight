import { getInstrument, type Instrument } from "@/lib/market/catalog";

/** Binance spot pair id (no dash). */
export function toBinanceSymbol(symbol: string): string | null {
  const inst = getInstrument(symbol);
  if (!inst || inst.market !== "crypto") return null;
  return symbol.replace(/-/g, "");
}

/** Yahoo Finance symbol (stocks / HK / A-share). */
export function toYahooSymbol(symbol: string): string | null {
  const inst = getInstrument(symbol);
  if (!inst || inst.market === "crypto") return null;
  return symbol;
}

export function splitSymbolsByProvider(symbols: string[]) {
  const binance: string[] = [];
  const yahoo: string[] = [];

  for (const symbol of symbols) {
    const inst = getInstrument(symbol);
    if (!inst) continue;
    if (inst.market === "crypto") binance.push(symbol);
    else yahoo.push(symbol);
  }

  return { binance, yahoo };
}

export function instrumentFor(symbol: string): Instrument | undefined {
  return getInstrument(symbol);
}
