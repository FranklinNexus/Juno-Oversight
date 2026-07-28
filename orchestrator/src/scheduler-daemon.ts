import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { classifyChildExit, readPersistedRunStatus } from "./child-process-state.js";
import { loadProjectEnv, nowIso, workbenchRoot, junoProjectRoot } from "./env.js";
import {
  mergeOrchestratorState,
  readOrchestratorState,
  shouldSkipSpawn,
  type OrchestratorState,
} from "./idempotency.js";
import { materializeQueueRun, readJsonFile, writeJsonFile } from "./manifest.js";
import {
  buildReviseImplementItem,
  checkpointTextForAdvance,
  evaluateCompletedRun,
  finalizeRunCheckpoint,
  markMissionPhaseDone,
  readRunKind,
  shouldMarkPhaseDone,
} from "./mission-progress.js";
import { evaluateLoopGate } from "./loop-gate.js";
import { parseNowYaml, saveNowQueue } from "./queue-io.js";
import type { QueueAdvanceAction } from "./review-loop.js";
import type { QueueItem, RunState, SchedulerState } from "./types.js";
import { appendEvent } from "./events.js";

const TICK_MS = 5_000;
const HEARTBEAT_STALE_MS = 5 * 60_000;

loadProjectEnv();

const workbench = workbenchRoot();
const projectRoot = junoProjectRoot();
const spawnScript = path.join(projectRoot, "orchestrator/dist/spawn-run.js");
const nodeBin = process.env.JUNO_NODE_PATH ?? "C:\\nvm4w\\nodejs\\node.exe";

let activeChild: ChildProcess | null = null;
let activeManifest = "";
let activeStartedAt = 0;
let activeMaxMinutes = 25;

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

function writeOrchestrator(status: string, runId?: string | null): void {
  const patch: Partial<OrchestratorState> = { activeRunStatus: status };
  if (runId === null) {
    patch.activeRunId = null;
  } else if (runId !== undefined) {
    patch.activeRunId = runId;
    patch.lastRunId = runId;
  }
  mergeOrchestratorState(workbench, patch);
}

function dequeueNowHead(): void {
  const { now, backlog } = parseNowYaml(workbench);
  if (now.length === 0) return;
  saveNowQueue(workbench, now.slice(1), backlog);
}

function prependNowItem(item: QueueItem): void {
  const { now, backlog } = parseNowYaml(workbench);
  saveNowQueue(workbench, [item, ...now], backlog);
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
    stdio: "inherit",
  });
  activeManifest = manifestPath;
  activeStartedAt = Date.now();
  activeMaxMinutes = maxMinutes;
  mergeOrchestratorState(workbench, {
    activeRunId: runId,
    activeRunStatus: "running",
    activeWorkerPid: activeChild.pid ?? null,
    lastRunId: runId,
  });
  activeChild.on("exit", (code, signal) => {
    const runDir = path.dirname(manifestPath);
    const persistedStatus = readPersistedRunStatus(runDir);
    const completionStatus = classifyChildExit(runDir, code);
    appendEvent(path.join(runDir, "events.jsonl"), {
      ts: nowIso(),
      type: "status",
      status: "child_exit",
      detail: `code=${String(code)} signal=${signal ?? "none"} persisted=${persistedStatus ?? "none"} classified=${completionStatus}`,
    });
    activeChild = null;
    activeManifest = "";
    mergeOrchestratorState(workbench, {
      activeRunId: runId,
      activeRunStatus: completionStatus,
      activeWorkerPid: null,
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
  return /STATUS:\s*COMPLETE/i.test(cp);
}

function handleCompletedRun(runId: string): QueueAdvanceAction {
  const sched = loadSchedulerState();
  const { now } = parseNowYaml(workbench);
  const head = now[0];
  const missionId = head?.mission_id;
  const runKind = readRunKind(workbench, runId);
  finalizeRunCheckpoint(workbench, runId, missionId, runKind);
  const action: QueueAdvanceAction = evaluateCompletedRun(workbench, runId, missionId);
  const checkpoint = checkpointTextForAdvance(workbench, runId, missionId);

  switch (action.action) {
    case "dequeue": {
      const ready = runKind === "implement" ? isTaskComplete(runId, missionId) : true;
      if (ready) {
        dequeueNowHead();
        if (head?.mission_id && head.phase_id && shouldMarkPhaseDone(runKind, checkpoint)) {
          markMissionPhaseDone(workbench, head.mission_id, head.phase_id);
        }
        sched.lastAction = "task_complete";
      } else {
        sched.lastAction = "await_complete";
      }
      break;
    }
    case "hold":
      sched.lastAction = action.reason;
      break;
    case "block":
      sched.lastAction = "blocked";
      break;
    case "revise":
      if (head) {
        dequeueNowHead();
        prependNowItem(buildReviseImplementItem(head, Date.now(), action.mustFix));
      }
      sched.lastAction = "review_revise";
      break;
  }

  saveSchedulerState(sched);
  if (action.action === "hold") {
    mergeOrchestratorState(workbench, {
      activeRunId: runId,
      activeRunStatus: "failed",
      activeWorkerPid: null,
    });
  } else if (action.action === "block") {
    mergeOrchestratorState(workbench, {
      activeRunId: runId,
      activeRunStatus: "blocked",
      activeWorkerPid: null,
    });
  } else {
    mergeOrchestratorState(workbench, {
      activeRunId: null,
      activeRunStatus: "idle",
      activeWorkerPid: null,
    });
  }
  return action;
}

async function tick(): Promise<void> {
  const sched = loadSchedulerState();
  if (!sched.enabled) return;
  sched.lastTickAt = nowIso();
  saveSchedulerState(sched);

  if (activeChild) {
    const runDir = path.dirname(activeManifest);
    if (readPersistedRunStatus(runDir) === "done") {
      activeChild.kill("SIGTERM");
      writeOrchestrator("done", path.basename(runDir));
      sched.lastAction = "reap_completed";
      saveSchedulerState(sched);
      return;
    }
    const elapsedMin = (Date.now() - activeStartedAt) / 60_000;
    if (heartbeatStale(runDir) || elapsedMin > activeMaxMinutes + 1) {
      activeChild.kill("SIGTERM");
      writeOrchestrator("stall", path.basename(runDir));
      sched.lastAction = "watchdog_kill";
      saveSchedulerState(sched);
    }
    return;
  }

  const orch = readOrchestrator();
  const status = orch.activeRunStatus ?? "idle";

  if (status === "running") return;

  if (status === "done") {
    const runId = orch.activeRunId ?? undefined;
    if (runId) {
      handleCompletedRun(runId);
    } else {
      writeOrchestrator("idle", null);
    }
    return;
  } else if (status === "stall" || status === "failed") {
    const runId = orch.activeRunId ?? undefined;
    if (runId) {
      const runDir = path.join(workbench, "runs", runId);
      const manifestPath = path.join(runDir, "manifest.json");
      if (existsSync(manifestPath) && shouldRetry(runDir)) {
        bumpRetry(runDir);
        const manifest = readJsonFile<{ maxMinutes: number }>(manifestPath);
        spawnSlot(manifestPath, manifest.maxMinutes ?? 25);
        sched.lastAction = "retry";
        sched.runsToday += 1;
        saveSchedulerState(sched);
        return;
      }
    }
    sched.lastAction = "retry_exhausted";
    saveSchedulerState(sched);
    mergeOrchestratorState(workbench, { activeRunStatus: "blocked", activeWorkerPid: null });
    return;
  } else if (status === "blocked") {
    sched.lastAction = sched.lastAction ?? "blocked";
    saveSchedulerState(sched);
    return;
  }

  const { now } = parseNowYaml(workbench);
  const next = now[0];

  if (inQuietHours() && !next?.interactive) {
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

  const manifestPath = materializeQueueRun(next);
  const manifest = readJsonFile<{ maxMinutes: number; runId: string }>(manifestPath);
  spawnSlot(manifestPath, manifest.maxMinutes ?? 25);
  sched.lastAction = "spawn";
  sched.lastRunId = manifest.runId;
  sched.runsToday += 1;
  saveSchedulerState(sched);
}

const pidPath = path.join(workbench, "state/daemon.pid");

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireDaemonPid(): boolean {
  mkdirSync(path.dirname(pidPath), { recursive: true });
  if (existsSync(pidPath)) {
    const existingPid = Number(readFileSync(pidPath, "utf8").trim());
    if (existingPid !== process.pid && processIsAlive(existingPid)) {
      process.stderr.write(`[scheduler] already running pid=${existingPid}\n`);
      return false;
    }
    try {
      unlinkSync(pidPath);
    } catch {
      return false;
    }
  }
  try {
    const fd = openSync(pidPath, "wx");
    writeFileSync(fd, String(process.pid), "utf8");
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function cleanupDaemonPid(): void {
  try {
    if (Number(readFileSync(pidPath, "utf8").trim()) === process.pid) {
      unlinkSync(pidPath);
    }
  } catch {
    // Already removed or replaced by a newer process.
  }
}

if (!acquireDaemonPid()) process.exit(0);

const schedInit = loadSchedulerState();
schedInit.enabled = true;
schedInit.daemonStartedAt = nowIso();
saveSchedulerState(schedInit);

process.stderr.write(`[scheduler] Juno Overseer daemon pid=${process.pid}\n`);

setInterval(() => {
  void tick().catch((err) => {
    process.stderr.write(`[scheduler] tick error: ${String(err)}\n`);
  });
}, TICK_MS);
void tick();

process.on("SIGTERM", () => {
  if (activeChild) activeChild.kill("SIGTERM");
  cleanupDaemonPid();
  process.exit(0);
});

process.on("SIGINT", () => {
  if (activeChild) activeChild.kill("SIGTERM");
  cleanupDaemonPid();
  process.exit(0);
});

process.on("exit", cleanupDaemonPid);
