import { NextResponse } from "next/server";
import type { ChartTimeframe } from "@/lib/market/ohlc";
import { fetchLiveOhlcSeries } from "@/lib/market/live/klines";

const TIMEFRAMES = new Set<ChartTimeframe>(["1m", "15m", "1h", "4h", "1d"]);

/** Dev-only proxy: static `pnpm build` export omits Route Handlers unless marked static. */
export const dynamic = "force-static";
export const revalidate = false;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol")?.trim() ?? "";
  const timeframe = url.searchParams.get("timeframe")?.trim() as ChartTimeframe;

  if (!symbol || !TIMEFRAMES.has(timeframe)) {
    return NextResponse.json({ error: "symbol and valid timeframe required" }, { status: 400 });
  }

  try {
    const bars = await fetchLiveOhlcSeries(symbol, timeframe);
    return NextResponse.json({ bars });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
