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
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void hasTauriRuntime()
      .then((ready) => {
        if (cancelled) return;
        setTauriReady(ready);
        setRuntimeChecked(true);
        if (!ready) setLoading(false);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setRuntimeChecked(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!tauriReady) {
      return;
    }
    let cancelled = false;
    const pull = async () => {
      try {
        const next = await getMissionsSnapshot();
        if (!cancelled) {
          setMissions(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
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

  const showLoading = !runtimeChecked || loading;

  return { missions, loading: showLoading, tauriReady, error };
}
