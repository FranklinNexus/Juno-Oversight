import type { MarketClass } from "@/lib/market/catalog";

export type BookLevel = {
  price: number;
  size: number;
};

export type MarketPayload = {
  id: string;
  timestamp: number;
  symbol: string;
  market: MarketClass;
  name: string;
  currency: string;
  last: number;
  changePct: number;
  volatility: number;
  alert: boolean;
  bids: BookLevel[];
  asks: BookLevel[];
  history: number[];
  /** 24h quote volume in quote currency (when live). */
  volume24h?: number;
  source: "mock" | "live";
};
