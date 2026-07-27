"use client";

import { useCallback, useEffect, useState } from "react";
import {
  hasTauriRuntime,
  submitMissionBrief,
  type SubmitMissionResult,
} from "@/lib/workbench/orchestrator-client";

export function useMissionBrief(onSubmitted?: () => void) {
  const [tauriReady, setTauriReady] = useState(false);
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitMissionResult | null>(null);

  useEffect(() => {
    hasTauriRuntime()
      .then(setTauriReady)
      .finally(() => setRuntimeChecked(true));
  }, []);

  const submit = useCallback(async (brief: string) => {
    const value = brief.trim();
    if (!tauriReady || value.length < 4) return false;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const next = await submitMissionBrief(value);
      setResult(next);
      onSubmitted?.();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [onSubmitted, tauriReady]);

  return { tauriReady, runtimeChecked, busy, error, result, submit };
}
