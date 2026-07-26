import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { nowIso } from "./env.js";
import { readJsonFile } from "./manifest.js";

export interface OrchestratorState {
  activeRunId?: string | null;
  activeRunStatus?: OrchestratorRunStatus | null;
  lastRunId?: string | null;
  updatedAt?: string;
}

export type SkipSpawnReason = "active_running" | "last_run_dedup";
export type OrchestratorRunStatus =
  | "idle"
  | "running"
  | "done"
  | "failed"
  | "blocked"
  | "stall";

const RETRY_STATUSES = new Set(["failed", "stall"]);
export const ORCHESTRATOR_RUN_STATUSES: readonly OrchestratorRunStatus[] = [
  "idle",
  "running",
  "done",
  "failed",
  "blocked",
  "stall",
];
const ORCHESTRATOR_RUN_STATUS_SET = new Set<string>(ORCHESTRATOR_RUN_STATUSES);

export function orchestratorStatePath(workbench: string): string {
  return path.join(workbench, "state/orchestrator.json");
}

function validateOrchestratorState(value: unknown, target: string): OrchestratorState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid orchestrator state: ${target}`);
  }
  const state = value as Record<string, unknown>;
  for (const key of ["activeRunId", "lastRunId"] as const) {
    if (state[key] !== undefined && state[key] !== null && typeof state[key] !== "string") {
      throw new Error(`Invalid orchestrator state ${key}: ${target}`);
    }
  }
  if (
    state.activeRunStatus !== undefined
    && state.activeRunStatus !== null
    && (
      typeof state.activeRunStatus !== "string"
      || !ORCHESTRATOR_RUN_STATUS_SET.has(state.activeRunStatus)
    )
  ) {
    throw new Error(`Invalid orchestrator state activeRunStatus: ${target}`);
  }
  if (
    state.updatedAt !== undefined
    && (typeof state.updatedAt !== "string" || !Number.isFinite(Date.parse(state.updatedAt)))
  ) {
    throw new Error(`Invalid orchestrator state updatedAt: ${target}`);
  }
  return state as OrchestratorState;
}

export function readOrchestratorState(workbench: string): OrchestratorState {
  const target = orchestratorStatePath(workbench);
  if (!existsSync(target)) return {};
  try {
    return validateOrchestratorState(readJsonFile<unknown>(target), target);
  } catch (error) {
    throw new Error(
      `Unable to read orchestrator state: ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function persistOrchestratorState(workbench: string, state: OrchestratorState): void {
  const target = orchestratorStatePath(workbench);
  const validated = validateOrchestratorState(state, target);
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
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
  status: OrchestratorRunStatus,
): void {
  const state = readOrchestratorState(workbench);

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
  persistOrchestratorState(workbench, state);
}

export function mergeOrchestratorState(
  workbench: string,
  patch: Partial<OrchestratorState>,
): void {
  const current = readOrchestratorState(workbench);
  persistOrchestratorState(workbench, {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  });
}
