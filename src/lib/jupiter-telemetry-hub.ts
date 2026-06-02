"use client";

import type { HudMode } from "@/store/hud-store";
import { useHudStore } from "@/store/hud-store";

export type JupiterTelemetry = {
  node: string;
  sshConnected: boolean;
  thermalC: number;
  npuPct: number;
  latencyMs: number;
  alert: boolean;
  source: "mock" | "tauri";
  ready: boolean;
};

type Subscriber = (data: JupiterTelemetry) => void;

const MOCK_BASE = {
  node: "JUPITER-EDGE-01",
  sshConnected: false,
  thermalC: 0,
  npuPct: 0,
  latencyMs: 0,
};

function mockTelemetry(mode: HudMode): JupiterTelemetry {
  const thermalC = Math.round(42 + Math.random() * 28);
  const npuPct = Math.round(
    mode === "surveillance" ? 35 + Math.random() * 55 : 15 + Math.random() * 40,
  );
  return {
    node: MOCK_BASE.node,
    sshConnected: true,
    thermalC,
    npuPct,
    latencyMs: Math.round(18 + Math.random() * 40),
    alert: thermalC > 62 || npuPct > 85,
    source: "mock",
    ready: true,
  };
}

async function fetchTauriTelemetry(): Promise<Omit<JupiterTelemetry, "source" | "alert" | "ready">> {
  const api = await import("@tauri-apps/api/core");
  return api.invoke("get_jupiter_telemetry");
}

const subscribers = new Map<symbol, Subscriber>();
let refCount = 0;
let pollMode: HudMode = "surveillance";
let intervalId: number | null = null;
let latest: JupiterTelemetry = {
  ...MOCK_BASE,
  alert: false,
  source: "mock",
  ready: false,
};

function publish(next: JupiterTelemetry) {
  latest = next;
  subscribers.forEach((listener) => listener(next));
}

async function pull() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return;
  }
  try {
    const payload = await fetchTauriTelemetry();
    publish({
      ...payload,
      alert: payload.thermalC > 62 || payload.npuPct > 85,
      source: "tauri",
      ready: true,
    });
  } catch {
    publish(mockTelemetry(pollMode));
  }
}

function intervalMsForMode(mode: HudMode) {
  return mode === "surveillance" ? 1000 : 2000;
}

function startPolling(mode: HudMode) {
  pollMode = mode;
  if (intervalId !== null) {
    window.clearInterval(intervalId);
  }
  pull();
  intervalId = window.setInterval(pull, intervalMsForMode(mode));
}

function stopPolling() {
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
}

function syncPollingToMode(mode: HudMode) {
  pollMode = mode;
  if (refCount === 0) return;
  startPolling(mode);
}

let hudModeUnsubscribe: (() => void) | null = null;
let lastHudMode: HudMode = "surveillance";

function ensureHudModeListener() {
  if (hudModeUnsubscribe) return;
  lastHudMode = useHudStore.getState().mode;
  hudModeUnsubscribe = useHudStore.subscribe((state) => {
    if (state.mode === lastHudMode) return;
    lastHudMode = state.mode;
    syncPollingToMode(state.mode);
  });
}

function releaseHudModeListener() {
  if (refCount > 0 || !hudModeUnsubscribe) return;
  hudModeUnsubscribe();
  hudModeUnsubscribe = null;
}

export function subscribeJupiterTelemetry(listener: Subscriber): () => void {
  const token = Symbol("jupiter-subscriber");
  subscribers.set(token, listener);
  refCount += 1;
  listener(latest);

  if (refCount === 1) {
    pollMode = useHudStore.getState().mode;
    ensureHudModeListener();
    startPolling(pollMode);
  }

  return () => {
    subscribers.delete(token);
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) {
      stopPolling();
      releaseHudModeListener();
    }
  };
}

export function getLatestJupiterTelemetry(): JupiterTelemetry {
  return latest;
}
