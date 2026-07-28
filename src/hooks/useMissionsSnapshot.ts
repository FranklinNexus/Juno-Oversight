"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getMissionsSnapshot,
  hasTauriRuntime,
  type MissionSummary,
} from "@/lib/workbench/orchestrator-client";

export function useMissionsSnapshot() {
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [tauriReady, setTauriReady] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    hasTauriRuntime().then(setTauriReady);
  }, []);

  useEffect(() => {
    if (!tauriReady) {
      return;
    }
    let cancelled = false;
    const pull = async () => {
      setLoading(true);
      try {
        const next = await getMissionsSnapshot();
        if (!cancelled) setMissions(next);
      } catch {
        // A transient desktop bridge failure must not erase the last known missions.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [tauriReady, tick]);

  const showLoading = !tauriReady || loading;

  return { missions, loading: showLoading, tauriReady, refresh };
}
