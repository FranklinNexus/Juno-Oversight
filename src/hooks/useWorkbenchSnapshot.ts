"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DEMO_WORKBENCH,
  EMPTY_WORKBENCH,
  type WorkbenchSnapshot,
} from "@/lib/workbench/types";
import {
  getWorkbenchSnapshot,
  hasTauriRuntime,
} from "@/lib/workbench/orchestrator-client";

const POLL_MS = 5000;

type WorkbenchSnapshotContextValue = WorkbenchSnapshot & {
  loading: boolean;
  refresh: () => void;
};

const WorkbenchSnapshotContext = createContext<WorkbenchSnapshotContextValue | null>(null);

async function fetchWorkbenchSnapshot(): Promise<WorkbenchSnapshot> {
  if (!(await hasTauriRuntime())) {
    return { ...DEMO_WORKBENCH, updatedAt: new Date().toISOString() };
  }
  return getWorkbenchSnapshot();
}

export function WorkbenchSnapshotProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>(EMPTY_WORKBENCH);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const latestRequest = useRef(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    const pull = async () => {
      const requestId = ++latestRequest.current;
      try {
        const next = await fetchWorkbenchSnapshot();
        if (!cancelled && requestId === latestRequest.current) setSnapshot(next);
      } catch (error) {
        if (!cancelled && requestId === latestRequest.current) {
          setSnapshot((current) => ({
            ...current,
            source: "tauri",
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      } finally {
        if (!cancelled && requestId === latestRequest.current) setLoading(false);
      }
    };

    pull();
    const id = window.setInterval(pull, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [tick]);

  const value = useMemo(
    () => ({ ...snapshot, loading, refresh }),
    [loading, refresh, snapshot],
  );

  return createElement(WorkbenchSnapshotContext.Provider, { value }, children);
}

export function useWorkbenchSnapshot(): WorkbenchSnapshotContextValue {
  const snapshot = useContext(WorkbenchSnapshotContext);
  if (!snapshot) {
    throw new Error("useWorkbenchSnapshot must be used within WorkbenchSnapshotProvider");
  }
  return snapshot;
}
