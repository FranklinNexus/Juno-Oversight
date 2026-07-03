"use client";

import { useCallback, useEffect, useState } from "react";
import {
  formatPromotePreviewSummary,
  hasTauriRuntime,
  listPromoteRules,
  listStagingEntries,
  previewPromoteToVault,
  promoteToVault,
  readPromoteLog,
  type PromotePreview,
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<PromotePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [promoteLog, setPromoteLog] = useState<string[]>([]);

  const defaultRule = rules[0]?.id ?? "jinstone-devlog";
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
        const [s, r, log] = await Promise.all([
          listStagingEntries(),
          listPromoteRules(),
          readPromoteLog(30),
        ]);
        if (!cancelled) {
          setStaging(s);
          setRules(r);
          setPromoteLog(log);
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

  const loadPreview = useCallback(
    async (relativePath: string, ruleId = defaultRule) => {
      setPreviewLoading(true);
      setMessage(null);
      try {
        const result = await previewPromoteToVault(ruleId, relativePath);
        setPreview(result);
        const log = await readPromoteLog(30);
        setPromoteLog(log);
      } catch (err) {
        setPreview(null);
        setMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setPreviewLoading(false);
      }
    },
    [defaultRule],
  );

  const selectEntry = useCallback(
    (relativePath: string) => {
      setSelectedPath(relativePath);
      void loadPreview(relativePath);
    },
    [loadPreview],
  );

  const promote = useCallback(
    async (ruleId: string, relativePath: string) => {
      setBusy(true);
      setMessage(null);
      try {
        const result = await promoteToVault(ruleId, relativePath);
        setMessage(result.message);
        const log = await readPromoteLog(30);
        setPromoteLog(log);
        refresh();
        void loadPreview(relativePath, ruleId);
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [loadPreview, refresh],
  );

  const showLoading = !tauriReady || loading;
  const previewText = preview ? formatPromotePreviewSummary(preview) : null;

  return {
    staging,
    rules,
    loading: showLoading,
    busy,
    message,
    tauriReady,
    promote,
    refresh,
    selectedPath,
    preview,
    previewText,
    previewLoading,
    promoteLog,
    selectEntry,
    defaultRule,
  };
}
