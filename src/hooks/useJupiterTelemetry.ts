"use client";

import { useEffect, useState } from "react";
import { useHudStore, type HudMode } from "@/store/hud-store";

export type JupiterTelemetry = {
  node: string;
  sshConnected: boolean;
  thermalC: number;
  npuPct: number;
  latencyMs: number;
  alert: boolean;
  source: "mock" | "tauri";
};

const MOCK_BASE: Omit<JupiterTelemetry, "source" | "alert"> = {
  node: "JUPITER-EDGE-01",
  sshConnected: false,
  thermalC: 0,
  npuPct: 0,
  latencyMs: 0,
};

function mockTelemetry(mode: HudMode): JupiterTelemetry {
  const thermalC = Math.round(42 + Math.random() * 28);
  const npuPct = Math.round(mode === "surveillance" ? 35 + Math.random() * 55 : 15 + Math.random() * 40);
  const alert = thermalC > 62 || npuPct > 85;
  return {
    node: MOCK_BASE.node,
    sshConnected: Math.random() > 0.08,
    thermalC,
    npuPct,
    latencyMs: Math.round(18 + Math.random() * 40),
    alert,
    source: "mock",
  };
}

async function fetchTauriTelemetry(): Promise<Omit<JupiterTelemetry, "source">> {
  const api = await import("@tauri-apps/api/core");
  return api.invoke<Omit<JupiterTelemetry, "source">>("get_jupiter_telemetry");
}

export function useJupiterTelemetry(): JupiterTelemetry {
  const mode = useHudStore((state) => state.mode);
  const [data, setData] = useState<JupiterTelemetry>(() => ({
    ...MOCK_BASE,
    alert: false,
    source: "mock",
  }));

  useEffect(() => {
    let mounted = true;
    const intervalMs = mode === "surveillance" ? 1000 : 2000;

    const pull = async () => {
      try {
        const payload = await fetchTauriTelemetry();
        if (!mounted) return;
        setData({
          ...payload,
          alert: payload.thermalC > 62 || payload.npuPct > 85,
          source: "tauri",
        });
      } catch {
        if (!mounted) return;
        setData(mockTelemetry(mode));
      }
    };

    pull();
    const intervalId = window.setInterval(pull, intervalMs);
    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, [mode]);

  return data;
}
