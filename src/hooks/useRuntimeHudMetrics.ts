"use client";

import { useEffect, useState } from "react";
import { useHudMetrics } from "@/hooks/useHudMetrics";

type TauriSnapshot = {
  cpuPct: number;
  ramMb: number;
  ramTotalMb: number;
};

type RuntimeMetrics = {
  cpuPct: number;
  ramMb: number;
  source: "mock" | "tauri";
};

async function fetchTauriMetrics(): Promise<TauriSnapshot> {
  const api = await import("@tauri-apps/api/core");
  return api.invoke<TauriSnapshot>("get_hud_system_snapshot");
}

export function useRuntimeHudMetrics(): RuntimeMetrics {
  const mock = useHudMetrics();
  const [tauriMetrics, setTauriMetrics] = useState<TauriSnapshot | null>(null);
  const [source, setSource] = useState<"mock" | "tauri">("mock");

  useEffect(() => {
    let mounted = true;
    let intervalId: number | null = null;

    const pull = async () => {
      try {
        const data = await fetchTauriMetrics();
        if (!mounted) return;
        setTauriMetrics(data);
        setSource("tauri");
      } catch {
        if (!mounted) return;
        setSource("mock");
      }
    };

    pull();
    intervalId = window.setInterval(pull, 1000);

    return () => {
      mounted = false;
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, []);

  if (source === "tauri" && tauriMetrics) {
    return { cpuPct: tauriMetrics.cpuPct, ramMb: tauriMetrics.ramMb, source };
  }

  return { cpuPct: mock.cpuPct, ramMb: mock.ramMb, source: "mock" };
}
