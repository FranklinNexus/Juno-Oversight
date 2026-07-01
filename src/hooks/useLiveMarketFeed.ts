"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { MarketPayload } from "@/lib/market/payload";
import {
  registerMockFeed,
  reportMockFeedLatency,
  unregisterMockFeed,
} from "@/lib/mock-feed-connection";
import type { HudMode } from "@/store/hud-store";

const POLL_MS: Record<HudMode, number> = {
  surveillance: 4000,
  focus: 2500,
};

export function useLiveMarketFeed(symbols: string[], mode: HudMode) {
  const [data, setData] = useState<MarketPayload[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reactId = useId();
  const instanceId = `market-live${reactId}`;
  const symbolsKey = symbols.join(",");
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (!symbolsKey || inFlight.current) return;
    inFlight.current = true;
    const started = performance.now();
    try {
      const res = await fetch(`/api/market/quotes?symbols=${encodeURIComponent(symbolsKey)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { rows: MarketPayload[] };
      setData(json.rows);
      setError(null);
      reportMockFeedLatency(instanceId, Math.round(performance.now() - started));
    } catch (err) {
      setError(err instanceof Error ? err.message : "live feed failed");
    } finally {
      inFlight.current = false;
    }
  }, [instanceId, symbolsKey]);

  useEffect(() => {
    if (!symbolsKey) return;

    registerMockFeed(instanceId, 20);
    const boot = window.setTimeout(() => void poll(), 0);
    const id = window.setInterval(() => void poll(), POLL_MS[mode]);

    return () => {
      window.clearTimeout(boot);
      window.clearInterval(id);
      unregisterMockFeed(instanceId);
    };
  }, [instanceId, mode, poll, symbolsKey]);

  return {
    data: symbolsKey ? data : [],
    error: symbolsKey ? error : null,
  };
}
