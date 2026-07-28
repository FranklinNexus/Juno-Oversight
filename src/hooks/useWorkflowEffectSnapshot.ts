"use client";

import { useEffect, useState } from "react";
import {
  EMPTY_WORKFLOW_EFFECT,
  type WorkflowEffectSnapshot,
} from "@/lib/workbench/types";

const POLL_MS = 15_000;
const TAURI_READ_TIMEOUT_MS = 1000;

async function fetchWorkflowEffectSnapshot(): Promise<WorkflowEffectSnapshot | null> {
  try {
    const request = import("@tauri-apps/api/core").then((api) =>
      api.invoke<WorkflowEffectSnapshot>("get_workflow_effect_snapshot"),
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

export function useWorkflowEffectSnapshot(): WorkflowEffectSnapshot & { loading: boolean } {
  const [snapshot, setSnapshot] = useState<WorkflowEffectSnapshot>(EMPTY_WORKFLOW_EFFECT);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      const next = await fetchWorkflowEffectSnapshot();
      if (!cancelled) {
        if (next) setSnapshot(next);
        setLoading(false);
      }
    };

    pull();
    const timer = window.setInterval(pull, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return { ...snapshot, loading };
}
