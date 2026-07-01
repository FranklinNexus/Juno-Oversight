"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getSchedulerStatus,
  hasTauriRuntime,
  startSchedulerDaemon,
  stopSchedulerDaemon,
  type SchedulerStatus,
} from "@/lib/workbench/orchestrator-client";

const POLL_MS = 5000;

const EMPTY: SchedulerStatus = {
  running: false,
  pid: null,
  enabled: false,
  runsToday: 0,
  lastAction: null,
  lastTickAt: null,
  daemonStartedAt: null,
};

export function useSchedulerStatus() {
  const [status, setStatus] = useState<SchedulerStatus>(EMPTY);
  const [tauriReady, setTauriReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    hasTauriRuntime().then(setTauriReady);
  }, []);

  useEffect(() => {
    if (!tauriReady) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const next = await getSchedulerStatus();
        if (!cancelled) setStatus(next);
      } catch {
        if (!cancelled) setStatus(EMPTY);
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [tauriReady, tick]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await startSchedulerDaemon());
      refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await stopSchedulerDaemon();
      refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return { status, tauriReady, busy, start, stop, refresh };
}
