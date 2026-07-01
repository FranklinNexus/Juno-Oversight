"use client";

import { useEffect, useState } from "react";
import {
  getMissionsSnapshot,
  hasTauriRuntime,
  type MissionSummary,
} from "@/lib/workbench/orchestrator-client";

export function useMissionsSnapshot() {
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [tauriReady, setTauriReady] = useState(false);

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
        if (!cancelled) setMissions([]);
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
  }, [tauriReady]);

  const showLoading = !tauriReady || loading;

  return { missions, loading: showLoading, tauriReady };
}
