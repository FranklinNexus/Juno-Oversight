import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
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
  evaluateCompletedRun,
  markMissionPhaseDone,
  readCheckpoint,
  readRunKind,
  shouldMarkPhaseDone,
} from "./mission-progress.js";
import { evaluateLoopGate } from "./loop-gate.js";
import { parseNowYaml, saveNowQueue } from "./queue-io.js";
import type { QueueAdvanceAction } from "./review-loop.js";
import type { QueueItem, RunState, SchedulerState } from "./types.js";

const TICK_MS = 5_000;
const HEARTBEAT_STALE_MS = 5 * 60_000;

loadProjectEnv();

const workbench = workbenchRoot();
const projectRoot = junoProjectRoot();
const spawnScript = path.join(projectRoot, "orchestrator/dist/spawn-run.js");
const nodeBin = process.env.JUNO_NODE_PATH ?? "C:\\nvm4w\\nodejs\\node.exe";

let activeChild: ChildProcessWithoutNullStreams | null = null;
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
    stdio: "pipe",
  });
  activeManifest = manifestPath;
  activeStartedAt = Date.now();
  activeMaxMinutes = maxMinutes;
  activeChild.on("exit", (code) => {
    activeChild = null;
    activeManifest = "";
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

function isTaskComplete(runId: string): boolean {
  const cp = path.join(workbench, "runs", runId, "checkpoint.md");
  try {
    const text = readFileSync(cp, "utf8");
    return /STATUS:\s*COMPLETE/i.test(text);
  } catch {
    return false;
  }
}

function handleCompletedRun(runId: string): void {
  const sched = loadSchedulerState();
  const action: QueueAdvanceAction = evaluateCompletedRun(workbench, runId);
  const { now } = parseNowYaml(workbench);
  const head = now[0];
  const checkpoint = readCheckpoint(workbench, runId);

  switch (action.action) {
    case "dequeue": {
      const runKind = readRunKind(workbench, runId);
      const ready = runKind === "implement" ? isTaskComplete(runId) : true;
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
  mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });
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
    writeOrchestrator("idle", null);
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

  const { now } = parseNowYaml(workbench);
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

  const manifestPath = materializeQueueRun(next);
  const manifest = readJsonFile<{ maxMinutes: number; runId: string }>(manifestPath);
  spawnSlot(manifestPath, manifest.maxMinutes ?? 25);
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
  process.exit(0);
});
