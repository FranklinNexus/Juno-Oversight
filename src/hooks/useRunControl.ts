"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_DEMO_MANIFEST,
  hasTauriRuntime,
  killAgentRun,
  spawnAgentRun,
} from "@/lib/workbench/orchestrator-client";

export function useRunControl(onChanged?: () => void) {
  const [tauriReady, setTauriReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hasTauriRuntime().then(setTauriReady);
  }, []);

  const spawn = useCallback(
    async (dryRun: boolean, manifestPath = DEFAULT_DEMO_MANIFEST) => {
      if (!tauriReady) {
        setError("需要 Tauri 桌面壳（pnpm tauri:dev）");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await spawnAgentRun(manifestPath, dryRun);
        onChanged?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onChanged, tauriReady],
  );

  const kill = useCallback(async () => {
    if (!tauriReady) return;
    setBusy(true);
    setError(null);
    try {
      await killAgentRun();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [onChanged, tauriReady]);

  return { tauriReady, busy, error, spawn, kill };
}
