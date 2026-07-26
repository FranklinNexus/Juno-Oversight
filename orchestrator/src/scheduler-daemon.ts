import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadProjectEnv, nowIso, workbenchRoot, junoProjectRoot } from "./env.js";
import {
  mergeOrchestratorState,
  readOrchestratorState,
  shouldSkipSpawn,
  type OrchestratorRunStatus,
  type OrchestratorState,
} from "./idempotency.js";
import { materializeQueueRun, readJsonFile, writeJsonFile } from "./manifest.js";
import {
  buildReviseImplementItem,
  checkpointTextForAdvance,
  evaluateCompletedRun,
  finalizeRunCheckpoint,
  markMissionPhaseDone,
  nextRevisionAttempt,
  readRunKind,
  shouldMarkPhaseDone,
} from "./mission-progress.js";
import { evaluateLoopGate } from "./loop-gate.js";
import { acquireAutonomyLock, readAutonomyLock, releaseAutonomyLock } from "./autonomy-lock.js";
import { readNowQueueSnapshot, replaceQueueHeadConditional } from "./queue-io.js";
import type { QueueAdvanceAction } from "./review-loop.js";
import type { QueueItem, RunState, SchedulerState } from "./types.js";
import { hasUniqueCompleteStatus } from "./checkpoint-status.js";
import {
  acquireRunLauncherLease,
  releaseRunLauncherLease,
  type RunSlotLease,
} from "./run-slot-lock.js";
import {
  finalizeOrdinaryVerifyQueueHead,
  recoverPendingVerifyCompletions,
} from "./mission-completion.js";
import { readWorkflowExperimentRevisionPromptBinding } from "./workflow-experiment.js";

const TICK_MS = 5_000;
const HEARTBEAT_STALE_MS = 5 * 60_000;

loadProjectEnv();

const workbench = workbenchRoot();
const projectRoot = junoProjectRoot();
const spawnScript = path.join(projectRoot, "orchestrator/dist/spawn-run.js");
const nodeBin = process.env.JUNO_NODE_PATH ?? "C:\\nvm4w\\nodejs\\node.exe";

if (!acquireAutonomyLock(workbench, "scheduler-daemon")) {
  const held = readAutonomyLock(workbench);
  process.stderr.write(
    `[scheduler] blocked by autonomy lock holder=${held?.holder ?? "?"} pid=${held?.pid ?? "?"}\n`,
  );
  process.exit(1);
}

let activeChild: ChildProcessWithoutNullStreams | null = null;
let activeManifest = "";
let activeStartedAt = 0;
let activeMaxMinutes = 25;
let activeLauncher: RunSlotLease | null = null;
let activeLauncherRunId = "";

function ensureLauncher(runId: string): boolean {
  if (activeLauncher) return activeLauncherRunId === runId;
  const lease = acquireRunLauncherLease(workbench, runId);
  if (!lease) return false;
  activeLauncher = lease;
  activeLauncherRunId = runId;
  return true;
}

function releaseLauncher(): boolean {
  if (!activeLauncher) return true;
  const lease = activeLauncher;
  activeLauncher = null;
  activeLauncherRunId = "";
  try {
    return releaseRunLauncherLease(lease);
  } catch (error) {
    process.stderr.write(`[scheduler] launcher cleanup failed: ${String(error)}\n`);
    return false;
  }
}

function schedulerStatePath(): string {
  return path.join(workbench, "state/scheduler.json");
}

function loadSchedulerState(): SchedulerState {
  try {
    return readJsonFile<SchedulerState>(schedulerStatePath());
  } catch {
    return { enabled: true, runsToday: 0, missionInjectIntervalMin: 90 };
  }
}

function saveSchedulerState(state: SchedulerState): void {
  mkdirSync(path.dirname(schedulerStatePath()), { recursive: true });
  writeJsonFile(schedulerStatePath(), state);
}

function readOrchestrator(): OrchestratorState {
  return readOrchestratorState(workbench);
}

function writeOrchestrator(status: OrchestratorRunStatus, runId?: string | null): void {
  const patch: Partial<OrchestratorState> = { activeRunStatus: status };
  if (runId === null) {
    patch.activeRunId = null;
  } else if (runId !== undefined) {
    patch.activeRunId = runId;
    patch.lastRunId = runId;
  }
  mergeOrchestratorState(workbench, patch);
}

function inQuietHours(): boolean {
  const cfg = path.join(workbench, "config.yaml");
  if (!existsSync(cfg)) return false;
  const text = readFileSync(cfg, "utf8");
  const startM = text.match(/start:\s*["']?(\d{2}:\d{2})/);
  const endM = text.match(/end:\s*["']?(\d{2}:\d{2})/);
  if (!startM || !endM) return false;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const toMins = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
  const s = toMins(startM[1]);
  const e = toMins(endM[1]);
  if (s <= e) return mins >= s && mins < e;
  return mins >= s || mins < e;
}

function heartbeatStale(runDir: string): boolean {
  const hb = path.join(runDir, "heartbeat.json");
  if (!existsSync(hb)) return true;
  return Date.now() - statSync(hb).mtimeMs > HEARTBEAT_STALE_MS;
}

function spawnSlot(manifestPath: string, maxMinutes: number): void {
  const node = existsSync(nodeBin) ? nodeBin : "node";
  const runId = path.basename(path.dirname(manifestPath));
  activeChild = spawn(node, [spawnScript, "--manifest", manifestPath], {
    env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench, JUNO_OVERSIGHT_ROOT: projectRoot },
    stdio: "pipe",
  });
  activeManifest = manifestPath;
  activeStartedAt = Date.now();
  activeMaxMinutes = maxMinutes;
  activeChild.on("exit", (code) => {
    activeChild = null;
    activeManifest = "";
    if (code === 4) {
      const sched = loadSchedulerState();
      sched.lastAction = "slot_busy";
      saveSchedulerState(sched);
      releaseLauncher();
      void tick().catch((err) => {
        process.stderr.write(`[scheduler] post-busy tick error: ${String(err)}\n`);
      });
      return;
    }
    mergeOrchestratorState(workbench, {
      activeRunId: runId,
      activeRunStatus: code === 0 ? "done" : "failed",
      lastRunId: runId,
    });
    void tick().catch((err) => {
      process.stderr.write(`[scheduler] post-exit tick error: ${String(err)}\n`);
    });
  });
}

function shouldRetry(runDir: string): boolean {
  try {
    const state = readJsonFile<RunState>(path.join(runDir, "run-state.json"));
    return state.retryCount < state.maxRetries;
  } catch {
    return false;
  }
}

function bumpRetry(runDir: string): void {
  const p = path.join(runDir, "run-state.json");
  const state = readJsonFile<RunState>(p);
  state.retryCount += 1;
  state.updatedAt = nowIso();
  writeJsonFile(p, state);
}

function isTaskComplete(runId: string, missionId?: string): boolean {
  const cp = checkpointTextForAdvance(workbench, runId, missionId);
  return hasUniqueCompleteStatus(cp);
}

function handleCompletedRun(runId: string): void {
  const sched = loadSchedulerState();
  const queueSnapshot = readNowQueueSnapshot(workbench);
  const { now } = queueSnapshot;
  const head = now[0];
  if (!head || head.id !== runId) {
    sched.lastAction = `queue_head_mismatch:${head?.id ?? "empty"}:${runId}`;
    saveSchedulerState(sched);
    mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "blocked" });
    return;
  }
  const missionId = head?.mission_id;
  const runKind = readRunKind(workbench, runId);
  finalizeRunCheckpoint(workbench, runId, missionId, runKind);
  const action: QueueAdvanceAction = evaluateCompletedRun(workbench, runId, missionId);
  const checkpoint = checkpointTextForAdvance(workbench, runId, missionId);
  const runDir = path.join(workbench, "runs", runId);
  let finalStatus: "idle" | "done" | "failed" | "blocked" = "idle";

  switch (action.action) {
    case "dequeue": {
      const ready = runKind === "implement" ? isTaskComplete(runId, missionId) : true;
      if (ready) {
        const terminalOrdinaryVerify =
          runKind === "verify" &&
          Boolean(missionId) &&
          ![...queueSnapshot.now.slice(1), ...queueSnapshot.backlog].some(
            (item) => item.mission_id === missionId,
          );
        let queueUpdate;
        try {
          queueUpdate = terminalOrdinaryVerify
            ? finalizeOrdinaryVerifyQueueHead(workbench, {
                expectedQueueRevision: queueSnapshot.revision,
                expectedHead: head,
              })
            : replaceQueueHeadConditional(workbench, {
                expectedRevision: queueSnapshot.revision,
                expectedHead: head,
                replacement: [],
              });
        } catch (error) {
          sched.lastAction = `completion_prepare_blocked:${String(error)}`;
          finalStatus = "blocked";
          break;
        }
        if (!queueUpdate.ok) {
          sched.lastAction = `queue_${queueUpdate.reason}:${runId}`;
          finalStatus = queueUpdate.reason === "busy" ? "done" : "blocked";
          break;
        }
        if (head?.mission_id && head.phase_id && shouldMarkPhaseDone(runKind, checkpoint)) {
          markMissionPhaseDone(workbench, head.mission_id, head.phase_id);
        }
        sched.lastAction = "task_complete";
      } else {
        sched.lastAction = "await_complete";
        finalStatus = shouldRetry(runDir) ? "failed" : "blocked";
      }
      break;
    }
    case "hold": {
      sched.lastAction = action.reason;
      finalStatus = shouldRetry(runDir) ? "failed" : "blocked";
      break;
    }
    case "block":
      sched.lastAction = "blocked";
      finalStatus = "blocked";
      break;
    case "revise":
      if (head) {
        let revisionItem: QueueItem;
        try {
          const revisionAttempt = nextRevisionAttempt(
            workbench,
            head.id,
            [...queueSnapshot.now, ...queueSnapshot.backlog],
          );
          const experimentPromptBinding = head.experiment_id
            ? readWorkflowExperimentRevisionPromptBinding(workbench, head)
            : undefined;
          revisionItem = buildReviseImplementItem(
            head,
            revisionAttempt,
            action.mustFix,
            experimentPromptBinding,
          );
        } catch (error) {
          sched.lastAction = `revision_binding_blocked:${String(error)}`;
          finalStatus = "blocked";
          break;
        }
        const queueUpdate = replaceQueueHeadConditional(workbench, {
          expectedRevision: queueSnapshot.revision,
          expectedHead: head,
          replacement: [revisionItem],
        });
        if (!queueUpdate.ok) {
          sched.lastAction = `queue_${queueUpdate.reason}:${runId}`;
          finalStatus = queueUpdate.reason === "busy" ? "done" : "blocked";
          break;
        }
      }
      sched.lastAction = "review_revise";
      break;
  }

  saveSchedulerState(sched);
  mergeOrchestratorState(workbench, {
    activeRunId: finalStatus === "idle" ? null : runId,
    activeRunStatus: finalStatus,
  });
}

async function tick(): Promise<void> {
  const sched = loadSchedulerState();
  if (!sched.enabled) return;
  sched.lastTickAt = nowIso();
  saveSchedulerState(sched);

  if (activeChild) {
    const runDir = path.dirname(activeManifest);
    const elapsedMin = (Date.now() - activeStartedAt) / 60_000;
    if (heartbeatStale(runDir) || elapsedMin > activeMaxMinutes + 1) {
      activeChild.kill("SIGTERM");
      writeOrchestrator("stall", path.basename(runDir));
      sched.lastAction = "watchdog_kill";
      saveSchedulerState(sched);
    }
    return;
  }

  let completionRecovery;
  try {
    completionRecovery = recoverPendingVerifyCompletions(workbench);
  } catch (error) {
    sched.lastAction = `completion_recovery_invalid:${String(error)}`;
    saveSchedulerState(sched);
    writeOrchestrator("blocked");
    return;
  }
  if (completionRecovery.status === "busy") {
    sched.lastAction = "completion_recovery_busy";
    saveSchedulerState(sched);
    return;
  }
  if (completionRecovery.status === "blocked") {
    sched.lastAction = `completion_recovery_blocked:${completionRecovery.reason ?? "unknown"}`;
    saveSchedulerState(sched);
    writeOrchestrator("blocked");
    return;
  }
  if (completionRecovery.status === "recovered") {
    sched.lastAction = `completion_recovered:${completionRecovery.recovered
      .map((entry) => entry.terminalRunId)
      .join(",")}`;
    saveSchedulerState(sched);
    writeOrchestrator("idle", null);
    return;
  }

  const orch = readOrchestrator();
  const status = orch.activeRunStatus ?? "idle";

  if (status === "running") return;
  if (status === "blocked") {
    releaseLauncher();
    sched.lastAction = "blocked";
    saveSchedulerState(sched);
    return;
  }

  if (status === "done") {
    const runId = orch.activeRunId ?? undefined;
    if (runId) {
      if (!ensureLauncher(runId)) {
        sched.lastAction = "launcher_busy";
        saveSchedulerState(sched);
        return;
      }
      try {
        handleCompletedRun(runId);
      } finally {
        releaseLauncher();
      }
    } else {
      writeOrchestrator("idle", null);
    }
    return;
  } else if (status === "stall" || status === "failed") {
    const runId = orch.activeRunId ?? undefined;
    if (runId) {
      if (!ensureLauncher(runId)) {
        sched.lastAction = "launcher_busy";
        saveSchedulerState(sched);
        return;
      }
      const runDir = path.join(workbench, "runs", runId);
      const manifestPath = path.join(runDir, "manifest.json");
      if (existsSync(manifestPath) && shouldRetry(runDir)) {
        try {
          bumpRetry(runDir);
          const manifest = readJsonFile<{ maxMinutes: number }>(manifestPath);
          spawnSlot(manifestPath, manifest.maxMinutes ?? 25);
        } catch (error) {
          releaseLauncher();
          throw error;
        }
        sched.lastAction = "retry";
        sched.runsToday += 1;
        saveSchedulerState(sched);
        return;
      }
    }
    releaseLauncher();
    writeOrchestrator("blocked", runId ?? null);
    sched.lastAction = "retry_exhausted";
    saveSchedulerState(sched);
    return;
  }

  if (inQuietHours()) {
    sched.lastAction = "quiet_hours";
    saveSchedulerState(sched);
    return;
  }

  const gate = evaluateLoopGate(workbench);
  if (!gate.ok) {
    sched.lastAction = "loop_gate_blocked";
    saveSchedulerState(sched);
    return;
  }

  const { now } = readNowQueueSnapshot(workbench);
  const next = now[0];
  if (!next) {
    sched.lastAction = "queue_empty";
    saveSchedulerState(sched);
    return;
  }

  const skip = shouldSkipSpawn(next.id, readOrchestratorState(workbench));
  if (skip) {
    sched.lastAction = skip;
    saveSchedulerState(sched);
    return;
  }

  if (!ensureLauncher(next.id)) {
    sched.lastAction = "launcher_busy";
    saveSchedulerState(sched);
    return;
  }
  let manifestPath: string;
  let manifest: { maxMinutes: number; runId: string };
  try {
    manifestPath = materializeQueueRun(next);
    manifest = readJsonFile<{ maxMinutes: number; runId: string }>(manifestPath);
    spawnSlot(manifestPath, manifest.maxMinutes ?? 25);
  } catch (error) {
    releaseLauncher();
    throw error;
  }
  sched.lastAction = "spawn";
  sched.lastRunId = manifest.runId;
  sched.runsToday += 1;
  saveSchedulerState(sched);
}

const schedInit = loadSchedulerState();
schedInit.daemonStartedAt = schedInit.daemonStartedAt ?? nowIso();
saveSchedulerState(schedInit);

writeFileSync(path.join(workbench, "state/daemon.pid"), String(process.pid), "utf8");
process.stderr.write(`[scheduler] Juno Overseer daemon pid=${process.pid}\n`);

setInterval(() => {
  void tick().catch((err) => {
    process.stderr.write(`[scheduler] tick error: ${String(err)}\n`);
  });
}, TICK_MS);
void tick();

process.on("SIGTERM", () => {
  if (activeChild) activeChild.kill("SIGTERM");
  releaseLauncher();
  releaseAutonomyLock(workbench, "scheduler-daemon");
  process.exit(0);
});
process.on("exit", () => {
  releaseLauncher();
  releaseAutonomyLock(workbench, "scheduler-daemon");
});
