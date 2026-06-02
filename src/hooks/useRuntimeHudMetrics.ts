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
  ramTotalMb?: number;
  source: "mock" | "tauri";
};

async function fetchTauriMetrics(): Promise<TauriSnapshot> {
  const api = await import("@tauri-apps/api/core");
  return api.invoke<TauriSnapshot>("get_hud_system_snapshot");
}

export function useRuntimeHudMetrics(): RuntimeMetrics {
  const [tauriMetrics, setTauriMetrics] = useState<TauriSnapshot | null>(null);
  const [source, setSource] = useState<"mock" | "tauri">("mock");
  const mock = useHudMetrics(source !== "tauri");

  useEffect(() => {
    let mounted = true;
    let intervalId: number | null = null;

    const pull = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const data = await fetchTauriMetrics();
        if (!mounted) return;
        setTauriMetrics(data);
        setSource("tauri");
      } catch {
        if (!mounted) return;
        setTauriMetrics(null);
        setSource("mock");
      }
    };

    const start = () => {
      pull();
      if (intervalId !== null) window.clearInterval(intervalId);
      intervalId = window.setInterval(pull, 1000);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") pull();
    };

    start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", onVisibility);
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, []);

  if (source === "tauri" && tauriMetrics) {
    return {
      cpuPct: tauriMetrics.cpuPct,
      ramMb: tauriMetrics.ramMb,
      ramTotalMb: tauriMetrics.ramTotalMb,
      source,
    };
  }

  return { cpuPct: mock.cpuPct, ramMb: mock.ramMb, source: "mock" };
}
