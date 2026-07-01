export const DEMO_RUN_ID = "demo-jupiter-bench";

export const DEFAULT_DEMO_MANIFEST = `E:\\AgentWorkbench\\runs\\${DEMO_RUN_ID}\\manifest.json`;

export type RunEventsResult = {
  runId: string;
  lines: string[];
};

export type SpawnRunResult = {
  runId: string;
  pid: number;
  status: string;
};

export async function hasTauriRuntime(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const w = window as Window & { __TAURI_INTERNALS__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__);
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const api = await import("@tauri-apps/api/core");
  return api.invoke<T>(cmd, args);
}

export async function spawnAgentRun(
  manifestPath: string,
  dryRun = false,
): Promise<SpawnRunResult> {
  return invoke<SpawnRunResult>("spawn_agent_run", { manifestPath, dryRun });
}

export async function killAgentRun(): Promise<void> {
  await invoke("kill_agent_run");
}

export type SchedulerStatus = {
  running: boolean;
  pid: number | null;
  enabled: boolean;
  runsToday: number;
  lastAction: string | null;
  lastTickAt: string | null;
  daemonStartedAt: string | null;
};

export type MissionPhase = { id: string; goal: string; status: string };
export type MissionSummary = {
  id: string;
  title: string;
  status: string;
  provider: string;
  currentPhaseId: string | null;
  phases: MissionPhase[];
  progressExcerpt: string | null;
};

export type StagingEntry = { relativePath: string; sizeBytes: number };
export type PromoteRule = {
  id: string;
  fromGlob: string;
  toPath: string;
  requireConfirm: boolean;
};
export type PromoteResult = { ok: boolean; copiedTo: string; message: string };

export async function startSchedulerDaemon(): Promise<SchedulerStatus> {
  return invoke<SchedulerStatus>("start_scheduler_daemon");
}

export async function stopSchedulerDaemon(): Promise<void> {
  await invoke("stop_scheduler_daemon");
}

export async function getSchedulerStatus(): Promise<SchedulerStatus> {
  return invoke<SchedulerStatus>("get_scheduler_status");
}

export async function getMissionsSnapshot(): Promise<MissionSummary[]> {
  return invoke<MissionSummary[]>("get_missions_snapshot");
}

export async function listStagingEntries(): Promise<StagingEntry[]> {
  return invoke<StagingEntry[]>("list_staging_entries");
}

export async function listPromoteRules(): Promise<PromoteRule[]> {
  return invoke<PromoteRule[]>("list_promote_rules");
}

export async function promoteToVault(
  ruleId: string,
  relativePath: string,
): Promise<PromoteResult> {
  return invoke<PromoteResult>("promote_to_vault", { ruleId, relativePath });
}

export async function readRunEvents(
  runId: string,
  maxLines = 80,
): Promise<RunEventsResult> {
  return invoke<RunEventsResult>("read_run_events", { runId, maxLines });
}

export function formatEventLine(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      type?: string;
      status?: string;
      text?: string;
      result?: string;
      message?: string;
      detail?: string;
      ts?: string;
    };
    const head = parsed.ts ? `[${parsed.ts}] ` : "";
    if (parsed.type === "assistant" && parsed.text) {
      return `${head}assistant: ${parsed.text}`;
    }
    if (parsed.type === "finished") {
      return `${head}finished (${parsed.status ?? "?"}): ${parsed.result ?? ""}`.trim();
    }
    if (parsed.type === "error") {
      return `${head}error: ${parsed.message ?? "unknown"}`;
    }
    if (parsed.type === "status") {
      return `${head}status: ${parsed.status ?? "?"}${parsed.detail ? ` · ${parsed.detail}` : ""}`;
    }
    return raw;
  } catch {
    return raw;
  }
}
