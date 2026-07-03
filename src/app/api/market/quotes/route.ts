import { NextResponse } from "next/server";
import { fetchLiveMarketBatch } from "@/lib/market/live/fetch-quotes";

/** Dev-only proxy: static `pnpm build` export omits Route Handlers unless marked static. */
export const dynamic = "force-static";
export const revalidate = false;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbols = (url.searchParams.get("symbols") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (symbols.length === 0) {
    return NextResponse.json({ rows: [] });
  }

  try {
    const rows = await fetchLiveMarketBatch(symbols);
    return NextResponse.json({ rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
