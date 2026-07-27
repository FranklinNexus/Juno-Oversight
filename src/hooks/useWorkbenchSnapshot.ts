"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEMO_WORKBENCH,
  type WorkbenchSnapshot,
} from "@/lib/workbench/types";

const POLL_MS = 5000;
const TAURI_READ_TIMEOUT_MS = 1000;

async function fetchWorkbenchSnapshot(): Promise<WorkbenchSnapshot> {
  try {
    const request = import("@tauri-apps/api/core").then((api) =>
      api.invoke<WorkbenchSnapshot>("get_workbench_snapshot"),
    );
    return await Promise.race([
      request,
      new Promise<WorkbenchSnapshot>((resolve) => {
        window.setTimeout(() => resolve(DEMO_WORKBENCH), TAURI_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return DEMO_WORKBENCH;
  }
}

export function useWorkbenchSnapshot(): WorkbenchSnapshot & {
  loading: boolean;
  refresh: () => void;
} {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>(DEMO_WORKBENCH);
  const [loading, setLoading] = useState(false);
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
