"use client";

import { useCallback, useEffect, useState } from "react";
import {
  hasTauriRuntime,
  listPromoteRules,
  listStagingEntries,
  promoteToVault,
  type PromoteRule,
  type StagingEntry,
} from "@/lib/workbench/orchestrator-client";

export function usePromotePanel() {
  const [staging, setStaging] = useState<StagingEntry[]>([]);
  const [rules, setRules] = useState<PromoteRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tauriReady, setTauriReady] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    hasTauriRuntime().then(setTauriReady);
  }, []);

  useEffect(() => {
    if (!tauriReady) return;
    let cancelled = false;
    const pull = async () => {
      setLoading(true);
      try {
        const [s, r] = await Promise.all([listStagingEntries(), listPromoteRules()]);
        if (!cancelled) {
          setStaging(s);
          setRules(r);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void pull();
    return () => {
      cancelled = true;
    };
  }, [tauriReady, tick]);

  const promote = useCallback(
    async (ruleId: string, relativePath: string) => {
      setBusy(true);
      setMessage(null);
      try {
        const result = await promoteToVault(ruleId, relativePath);
        setMessage(result.message);
        refresh();
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const showLoading = !tauriReady || loading;

  return { staging, rules, loading: showLoading, busy, message, tauriReady, promote, refresh };
}
