"use client";

import { useCallback, useEffect, useState } from "react";
import {
  formatEventLine,
  hasTauriRuntime,
  readRunEvents,
} from "@/lib/workbench/orchestrator-client";

const POLL_MS = 2000;

export function useRunEvents(runId: string | null, enabled: boolean) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [tauriReady, setTauriReady] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    hasTauriRuntime().then(setTauriReady);
  }, []);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !runId || !tauriReady) return;

    let cancelled = false;

    const pull = async () => {
      setLoading(true);
      try {
        const result = await readRunEvents(runId, 80);
        if (!cancelled) {
          setLines(result.lines.map(formatEventLine));
        }
      } catch {
        if (!cancelled) {
          setLines(["（无法读取 events.jsonl — 确认 Tauri 桌面壳已启动）"]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void pull();
    const id = window.setInterval(() => {
      void pull();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled, runId, tauriReady, tick]);

  const visibleLines = enabled && runId && tauriReady ? lines : [];

  return { lines: visibleLines, loading, tauriReady, refresh };
}
