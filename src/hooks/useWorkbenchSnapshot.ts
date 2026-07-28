"use client";

import { useCallback, useEffect, useState } from "react";
import {
  EMPTY_WORKBENCH,
  type WorkbenchSnapshot,
} from "@/lib/workbench/types";

const POLL_MS = 5000;
const TAURI_READ_TIMEOUT_MS = 1000;

async function fetchWorkbenchSnapshot(): Promise<WorkbenchSnapshot | null> {
  try {
    const request = import("@tauri-apps/api/core").then((api) =>
      api.invoke<WorkbenchSnapshot>("get_workbench_snapshot"),
    );
    return await Promise.race([
      request,
      new Promise<null>((resolve) => {
        window.setTimeout(() => resolve(null), TAURI_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  }
}

export function useWorkbenchSnapshot(): WorkbenchSnapshot & {
  loading: boolean;
  refresh: () => void;
} {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>(EMPTY_WORKBENCH);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    const pull = async () => {
      const next = await fetchWorkbenchSnapshot();
      if (!cancelled) {
        if (next) setSnapshot(next);
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
