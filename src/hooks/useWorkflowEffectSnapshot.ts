"use client";

import { useEffect, useState } from "react";
import {
  EMPTY_WORKFLOW_EFFECT,
  type WorkflowEffectSnapshot,
} from "@/lib/workbench/types";

const POLL_MS = 15_000;

async function fetchWorkflowEffectSnapshot(): Promise<WorkflowEffectSnapshot> {
  try {
    const api = await import("@tauri-apps/api/core");
    return await api.invoke<WorkflowEffectSnapshot>("get_workflow_effect_snapshot");
  } catch {
    return EMPTY_WORKFLOW_EFFECT;
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
        setSnapshot(next);
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
