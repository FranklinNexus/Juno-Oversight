"use client";

import { useEffect, useState } from "react";

type HudMetrics = {
  cpuPct: number;
  ramMb: number;
};

const INITIAL: HudMetrics = { cpuPct: 9, ramMb: 242 };

function nextMockMetrics(prev: HudMetrics): HudMetrics {
  const cpuShift = (Math.random() - 0.5) * 4;
  const ramShift = (Math.random() - 0.5) * 10;
  return {
    cpuPct: Math.max(3, Math.min(68, Math.round(prev.cpuPct + cpuShift))),
    ramMb: Math.max(180, Math.min(620, Math.round(prev.ramMb + ramShift))),
  };
}

export function useHudMetrics(enabled = true): HudMetrics {
  const [metrics, setMetrics] = useState<HudMetrics>(INITIAL);

  useEffect(() => {
    if (!enabled) return;
    const interval = window.setInterval(() => {
      setMetrics((prev) => nextMockMetrics(prev));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [enabled]);

  return metrics;
}
