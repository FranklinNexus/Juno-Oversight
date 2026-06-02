import { useHudStore } from "@/store/hud-store";

/** Per mock-socket instance (e.g. market:_R_abc_), not per feed type. */
const activeFeeds = new Map<string, number>();

function publishConnectionState() {
  const { setConnection } = useHudStore.getState();
  if (activeFeeds.size === 0) {
    setConnection(false, 0);
    return;
  }
  const latencyMs = Math.max(...activeFeeds.values());
  setConnection(true, latencyMs);
}

export function registerMockFeed(instanceId: string, initialLatencyMs = 15) {
  activeFeeds.set(instanceId, initialLatencyMs);
  publishConnectionState();
}

export function unregisterMockFeed(instanceId: string) {
  activeFeeds.delete(instanceId);
  publishConnectionState();
}

export function reportMockFeedLatency(instanceId: string, latencyMs: number) {
  if (!activeFeeds.has(instanceId)) return;
  activeFeeds.set(instanceId, latencyMs);
  publishConnectionState();
}

/** @internal test helper */
export function resetMockFeedConnectionForTests() {
  activeFeeds.clear();
  useHudStore.getState().setConnection(false, 0);
}
