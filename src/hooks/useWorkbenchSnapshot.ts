"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEMO_WORKBENCH,
  EMPTY_WORKBENCH,
  type WorkbenchSnapshot,
} from "@/lib/workbench/types";

const POLL_MS = 5000;

async function fetchWorkbenchSnapshot(): Promise<WorkbenchSnapshot> {
  try {
    const api = await import("@tauri-apps/api/core");
    return await api.invoke<WorkbenchSnapshot>("get_workbench_snapshot");
  } catch {
    return DEMO_WORKBENCH;
  }
}

export function useWorkbenchSnapshot(): WorkbenchSnapshot & {
  loading: boolean;
  refresh: () => void;
} {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>(EMPTY_WORKBENCH);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    const pull = async () => {
      const next = await fetchWorkbenchSnapshot();
      if (!cancelled) {
        setSnapshot(next);
        setLoading(false);
      }
    };

    pull();
    const id = window.setInterval(pull, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [tick]);

  return { ...snapshot, loading, refresh };
}
