import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nowIso } from "./env.js";
import { readJsonFile, writeJsonFile } from "./manifest.js";

export interface OrchestratorState {
  activeRunId?: string | null;
  activeRunStatus?: string | null;
  lastRunId?: string | null;
  updatedAt?: string;
}

export type SkipSpawnReason = "active_running" | "last_run_dedup";

const RETRY_STATUSES = new Set(["failed", "stall"]);

export function orchestratorStatePath(workbench: string): string {
  return path.join(workbench, "state/orchestrator.json");
}

export function readOrchestratorState(workbench: string): OrchestratorState {
  try {
    return readJsonFile<OrchestratorState>(orchestratorStatePath(workbench));
  } catch {
    return {};
  }
}

export function normalizeRunStatus(status?: string | null): string {
  return (status ?? "idle").trim().toLowerCase() || "idle";
}

/** Returns a skip reason when spawn would duplicate an active or recently finished run. */
export function shouldSkipSpawn(runId: string, state: OrchestratorState): SkipSpawnReason | null {
  const status = normalizeRunStatus(state.activeRunStatus);

  if (state.activeRunId === runId && status === "running") {
    return "active_running";
  }

  if (state.lastRunId === runId && !RETRY_STATUSES.has(status)) {
    return "last_run_dedup";
  }

  return null;
}

export function writeOrchestratorState(
  workbench: string,
  runId: string,
  status: string,
): void {
  const statePath = orchestratorStatePath(workbench);
  let state: OrchestratorState = {};
  try {
    state = JSON.parse(readFileSync(statePath, "utf8")) as OrchestratorState;
  } catch {
    state = {};
  }

  if (
    status === "running" &&
    state.activeRunId === runId &&
    normalizeRunStatus(state.activeRunStatus) === "running"
  ) {
    return;
  }

  state.activeRunId = runId;
  state.activeRunStatus = status;
  state.lastRunId = runId;
  state.updatedAt = nowIso();
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function mergeOrchestratorState(
  workbench: string,
  patch: Partial<OrchestratorState>,
): void {
  const current = readOrchestratorState(workbench);
  writeJsonFile(orchestratorStatePath(workbench), {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  });
}
