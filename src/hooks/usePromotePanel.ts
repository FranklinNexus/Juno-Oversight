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

  const ruleForPath = useCallback(
    (relativePath: string) => {
      const normalized = relativePath.replace(/\\/g, "/");
      return rules.find((rule) => {
        const prefix = rule.fromGlob.replace(/\\/g, "/").replace(/\/\*\*$/, "").replace(/\/$/, "");
        return normalized === prefix || normalized.startsWith(`${prefix}/`);
      });
    },
    [rules],
  );
  const defaultRule = selectedPath
    ? (ruleForPath(selectedPath)?.id ?? "")
    : (rules[0]?.id ?? "");
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
      const rule = ruleForPath(relativePath);
      if (!rule) {
        setPreview(null);
        setMessage(`没有 Promote rule 覆盖 ${relativePath}`);
        return;
      }
      void loadPreview(relativePath, rule.id);
    },
    [loadPreview, ruleForPath],
  );

  const promote = useCallback(
    async (ruleId: string, relativePath: string) => {
      setBusy(true);
      setMessage(null);
      try {
        const rule = rules.find((candidate) => candidate.id === ruleId);
        if (!rule) throw new Error(`Promote rule 不存在或不匹配：${ruleId || "(none)"}`);
        const confirmed = window.confirm(
          `确认 Promote 到 Vault？\n\n${relativePath}\n→ ${rule.toPath}`,
        );
        if (!confirmed) return;
        const result = await promoteToVault(ruleId, relativePath, true);
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
    [loadPreview, refresh, rules],
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
