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
  DEMO_RECOVERY_INVENTORY,
  EMPTY_RECOVERY_INVENTORY,
  type RecoveryInventory,
} from "@/lib/workbench/types";
import {
  hasTauriRuntime,
  inspectOperatorRecovery,
} from "@/lib/workbench/orchestrator-client";

const POLL_MS = 15_000;

type OperatorRecoveryContextValue = RecoveryInventory & {
  loading: boolean;
  error: string | null;
  tauriReady: boolean;
  refresh: () => void;
};

const OperatorRecoveryContext = createContext<OperatorRecoveryContextValue | null>(null);

export function OperatorRecoveryProvider({ children }: { children: ReactNode }) {
  const [inventory, setInventory] = useState<RecoveryInventory>(EMPTY_RECOVERY_INVENTORY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tauriReady, setTauriReady] = useState(false);
  const [tick, setTick] = useState(0);
  const latestRequest = useRef(0);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;

    const pull = async () => {
      const requestId = ++latestRequest.current;
      try {
        const desktop = await hasTauriRuntime();
        const next = desktop
          ? await inspectOperatorRecovery()
          : { ...DEMO_RECOVERY_INVENTORY, observedAt: new Date().toISOString() };
        if (!cancelled && requestId === latestRequest.current) {
          setTauriReady(desktop);
          setInventory(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled && requestId === latestRequest.current) {
          setTauriReady(true);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled && requestId === latestRequest.current) setLoading(false);
      }
    };

    void pull();
    const timer = window.setInterval(pull, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tick]);

  const value = useMemo(
    () => ({ ...inventory, loading, error, tauriReady, refresh }),
    [error, inventory, loading, refresh, tauriReady],
  );

  return createElement(OperatorRecoveryContext.Provider, { value }, children);
}

export function useOperatorRecovery(): OperatorRecoveryContextValue {
  const recovery = useContext(OperatorRecoveryContext);
  if (!recovery) {
    throw new Error("useOperatorRecovery must be used within OperatorRecoveryProvider");
  }
  return recovery;
}
