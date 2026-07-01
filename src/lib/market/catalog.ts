export type MarketClass = "crypto" | "us" | "hk" | "cn_a";

export type Instrument = {
  /** Canonical id used in store / feed */
  symbol: string;
  name: string;
  /** Localized name (ZH) */
  nameLocal?: string;
  /** UI ticker code */
  displayCode?: string;
  market: MarketClass;
  basePrice: number;
  currency: string;
};

export const MARKET_LABELS: Record<MarketClass, string> = {
  crypto: "CRYPTO",
  us: "US",
  hk: "HK",
  cn_a: "A-SHARE",
};

export const INSTRUMENT_CATALOG: Instrument[] = [
  { symbol: "BTC-USDT", name: "Bitcoin", market: "crypto", basePrice: 68320, currency: "USD" },
  { symbol: "ETH-USDT", name: "Ethereum", market: "crypto", basePrice: 3670, currency: "USD" },
  { symbol: "SOL-USDT", name: "Solana", market: "crypto", basePrice: 175, currency: "USD" },
  { symbol: "XRP-USDT", name: "XRP", market: "crypto", basePrice: 0.62, currency: "USD" },
  { symbol: "DOGE-USDT", name: "Dogecoin", market: "crypto", basePrice: 0.14, currency: "USD" },
  { symbol: "NVDA", name: "NVIDIA", market: "us", basePrice: 123.6, currency: "USD" },
  { symbol: "AAPL", name: "Apple", market: "us", basePrice: 228.4, currency: "USD" },
  { symbol: "TSLA", name: "Tesla", market: "us", basePrice: 248.2, currency: "USD" },
  { symbol: "SPY", name: "S&P 500 ETF", market: "us", basePrice: 512.8, currency: "USD" },
  { symbol: "MSFT", name: "Microsoft", market: "us", basePrice: 428.5, currency: "USD" },
  { symbol: "GOOGL", name: "Alphabet", market: "us", basePrice: 176.2, currency: "USD" },
  { symbol: "AMZN", name: "Amazon", market: "us", basePrice: 186.4, currency: "USD" },
  { symbol: "META", name: "Meta", market: "us", basePrice: 512.1, currency: "USD" },
  { symbol: "COIN", name: "Coinbase", market: "us", basePrice: 228.7, currency: "USD" },
  {
    symbol: "0700.HK",
    displayCode: "00700",
    name: "Tencent",
    nameLocal: "腾讯控股",
    market: "hk",
    basePrice: 368.2,
    currency: "HKD",
  },
  {
    symbol: "9988.HK",
    displayCode: "09988",
    name: "Alibaba",
    nameLocal: "阿里巴巴-SW",
    market: "hk",
    basePrice: 78.5,
    currency: "HKD",
  },
  {
    symbol: "3690.HK",
    displayCode: "03690",
    name: "Meituan",
    nameLocal: "美团-W",
    market: "hk",
    basePrice: 112.4,
    currency: "HKD",
  },
  {
    symbol: "600519.SS",
    displayCode: "600519",
    name: "Kweichow Moutai",
    nameLocal: "贵州茅台",
    market: "cn_a",
    basePrice: 1680,
    currency: "CNY",
  },
  {
    symbol: "000001.SZ",
    displayCode: "000001",
    name: "Ping An Bank",
    nameLocal: "平安银行",
    market: "cn_a",
    basePrice: 12.4,
    currency: "CNY",
  },
  {
    symbol: "300750.SZ",
    displayCode: "300750",
    name: "CATL",
    nameLocal: "宁德时代",
    market: "cn_a",
    basePrice: 186.5,
    currency: "CNY",
  },
];

export const DEFAULT_WATCHLIST = [
  "BTC-USDT",
  "ETH-USDT",
  "NVDA",
  "AAPL",
  "0700.HK",
  "600519.SS",
];

const catalogMap = new Map(INSTRUMENT_CATALOG.map((item) => [item.symbol, item]));

export function getInstrument(symbol: string): Instrument | undefined {
  return catalogMap.get(symbol);
}

export function listInstruments(market: MarketClass | "all"): Instrument[] {
  if (market === "all") return INSTRUMENT_CATALOG;
  return INSTRUMENT_CATALOG.filter((item) => item.market === market);
}
