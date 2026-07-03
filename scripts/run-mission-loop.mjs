#!/usr/bin/env node
/**
 * Generic mission loop — spawn one Live slot from queue head (hardening, etc.).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

function log(m) {
  process.stderr.write(`[mission-loop] ${m}\n`);
}

const build = spawnSync("pnpm", ["orchestrator:build"], { cwd: repoRoot, stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const { loadProjectEnv } = await import("../orchestrator/dist/env.js");
loadProjectEnv();

const { parseNowYaml, saveNowQueue } = await import("../orchestrator/dist/queue-io.js");
const { materializeQueueRun } = await import("../orchestrator/dist/manifest.js");
const {
  evaluateCompletedRun,
  markMissionPhaseDone,
  readRunKind,
  shouldMarkPhaseDone,
  buildReviseImplementItem,
  checkpointTextForAdvance,
} = await import("../orchestrator/dist/mission-progress.js");
const { mergeOrchestratorState } = await import("../orchestrator/dist/idempotency.js");

let { now, backlog } = parseNowYaml(workbench);
if (now.length === 0) {
  log("queue empty — nothing to advance");
  process.exit(0);
}

const { repairHardeningQueue, HARDENING_MISSION_ID } = await import(
  "../orchestrator/dist/hardening-queue.js"
);

let head = now[0];
if (head.mission_id === HARDENING_MISSION_ID) {
  const repair = repairHardeningQueue(workbench);
  if (repair.changed) {
    log(`repaired hardening queue: ${repair.reason}`);
    ({ now, backlog } = parseNowYaml(workbench));
    if (now.length === 0) {
      log("queue empty after repair");
      process.exit(0);
    }
    head = now[0];
  }
}
if (!process.env.CURSOR_API_KEY?.trim()) {
  log("blocked: CURSOR_API_KEY required for Live slot");
  process.exit(3);
}

log(`live spawn ${head.id} (${head.phase_id}) mission=${head.mission_id}`);

const manifestPath = materializeQueueRun(head);
const spawnScript = path.join(repoRoot, "orchestrator", "dist", "spawn-run.js");
const r = spawnSync("node", [spawnScript, "--manifest", manifestPath], {
  cwd: repoRoot,
  env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench, JUNO_OVERSIGHT_ROOT: repoRoot },
  stdio: "inherit",
  shell: false,
});

if ((r.status ?? 1) !== 0) {
  log(`spawn-run exit ${r.status}`);
  process.exit(r.status ?? 1);
}

const runDir = path.join(workbench, "runs", head.id);
const cpPath = path.join(runDir, "checkpoint.md");
if (!existsSync(cpPath)) {
  log("no checkpoint.md after live slot");
  process.exit(1);
}

const cp = checkpointTextForAdvance(workbench, head.id, head.mission_id);
let action = evaluateCompletedRun(workbench, head.id, head.mission_id);
const runKind = readRunKind(workbench, head.id);

if (action.action === "revise") {
  const fix = buildReviseImplementItem(head, Date.now(), action.mustFix ?? []);
  ({ now, backlog } = parseNowYaml(workbench));
  saveNowQueue(workbench, [fix, ...now.slice(1)], backlog);
  mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });
  log(`REVISE fix queued for ${head.phase_id}`);
  process.exit(0);
}

if (action.action !== "dequeue") {
  log(`not dequeue-ready: ${action.action}`);
  process.exit(2);
}

if (head.mission_id && head.phase_id && shouldMarkPhaseDone(runKind, cp)) {
  markMissionPhaseDone(workbench, head.mission_id, head.phase_id);
}

({ now, backlog } = parseNowYaml(workbench));
saveNowQueue(workbench, now.slice(1), backlog);
mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });
log(`done ${head.id}`);
