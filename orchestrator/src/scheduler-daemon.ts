import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadProjectEnv, nowIso, workbenchRoot, junoProjectRoot } from "./env.js";
import { mergeOrchestratorState } from "./idempotency.js";
import { materializeQueueRun, readJsonFile, writeJsonFile } from "./manifest.js";
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

function orchestratorPath(): string {
  return path.join(workbench, "state/orchestrator.json");
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

function readOrchestrator(): { activeRunId?: string | null; activeRunStatus?: string } {
  try {
    return readJsonFile(orchestratorPath());
  } catch {
    return {};
  }
}

function writeOrchestrator(status: string, runId?: string | null): void {
  const current = readOrchestrator() as Record<string, unknown>;
  writeJsonFile(orchestratorPath(), {
    ...current,
    activeRunId: runId ?? current.activeRunId ?? null,
    activeRunStatus: status,
    lastRunId: runId ?? current.lastRunId ?? null,
    updatedAt: nowIso(),
  });
}

function parseNowYaml(): { now: QueueItem[]; backlog: QueueItem[] } {
  const file = path.join(workbench, "queue/now.yaml");
  if (!existsSync(file)) return { now: [], backlog: [] };
  const text = readFileSync(file, "utf8");
  const sections: Record<"now" | "backlog", QueueItem[]> = { now: [], backlog: [] };
  let section: "now" | "backlog" = "now";
  let item: Partial<QueueItem> | null = null;

  const pushItem = () => {
    if (item?.id) sections[section].push(item as QueueItem);
    item = null;
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("now:")) {
      pushItem();
      section = "now";
      continue;
    }
    if (line.startsWith("backlog:")) {
      pushItem();
      section = "backlog";
      continue;
    }
    const listId = line.match(/^\s*-\s*id:\s*(.+)$/);
    if (listId) {
      pushItem();
      item = {
        id: listId[1].trim().replace(/^["']|["']$/g, ""),
        horizon: "day",
        kind: "task",
        prompt: "executor_generic",
      };
      continue;
    }
    if (!item) continue;
    const m = line.match(/^\s{2,}([a-z_]+):\s*(.+)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.trim().replace(/^["']|["']$/g, "");
    if (key === "horizon") item.horizon = val as QueueItem["horizon"];
    if (key === "kind") item.kind = val;
    if (key === "run_kind") item.run_kind = val as QueueItem["run_kind"];
    if (key === "repo_target") item.repo_target = val as QueueItem["repo_target"];
    if (key === "prompt") item.prompt = val;
    if (key === "provider") item.provider = val as QueueItem["provider"];
    if (key === "max_minutes") item.max_minutes = Number(val);
    if (key === "mission_id") item.mission_id = val;
    if (key === "phase_id") item.phase_id = val;
  }
  pushItem();
  return { now: sections.now, backlog: sections.backlog };
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

function dequeueNowHead(): void {
  const file = path.join(workbench, "queue/now.yaml");
  if (!existsSync(file)) return;
  const { now } = parseNowYaml();
  if (now.length === 0) return;
  const rest = now.slice(1);
  const lines: string[] = [`updated: ${nowIso()}`, "now:"];
  for (const item of rest) {
    lines.push(`  - id: ${item.id}`);
    lines.push(`    horizon: ${item.horizon}`);
    lines.push(`    kind: ${item.kind}`);
    lines.push(`    prompt: ${item.prompt}`);
    if (item.provider) lines.push(`    provider: ${item.provider}`);
    if (item.max_minutes) lines.push(`    max_minutes: ${item.max_minutes}`);
    if (item.mission_id) lines.push(`    mission_id: ${item.mission_id}`);
    if (item.phase_id) lines.push(`    phase_id: ${item.phase_id}`);
  }
  lines.push("backlog: []");
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
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
    if (runId && isTaskComplete(runId)) {
      dequeueNowHead();
      sched.lastAction = "task_complete";
      saveSchedulerState(sched);
    }
    writeOrchestrator("idle", null);
  }

  if (status === "stall" || status === "failed") {
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

  const { now } = parseNowYaml();
  const next = now[0];
  if (!next) {
    sched.lastAction = "queue_empty";
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
schedInit.enabled = true;
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
