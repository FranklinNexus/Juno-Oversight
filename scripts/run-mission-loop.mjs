#!/usr/bin/env node
/**
 * Generic mission loop — spawn one Live slot from queue head (hardening, etc.).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

function log(m) {
  process.stderr.write(`[mission-loop] ${m}\n`);
}

const advanceOnly =
  process.argv.includes("--advance-only") || process.argv.includes("--skip-spawn");

const skipBuild =
  process.argv.includes("--skip-build") ||
  process.env.JUNO_SKIP_ORCHESTRATOR_BUILD === "1";
if (!skipBuild) {
  const build = spawnSync("pnpm", ["orchestrator:build"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

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
  finalizeRunCheckpoint,
} = await import("../orchestrator/dist/mission-progress.js");
const { mergeOrchestratorState } = await import("../orchestrator/dist/idempotency.js");

let { now, backlog } = parseNowYaml(workbench);
if (now.length === 0) {
  log("queue empty — nothing to advance");
  process.exit(4);
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
      process.exit(4);
    }
    head = now[0];
  }
}
if (!advanceOnly && !process.env.CURSOR_API_KEY?.trim()) {
  log("blocked: CURSOR_API_KEY required for Live slot");
  process.exit(3);
}

log(`${advanceOnly ? "advance" : "live spawn"} ${head.id} (${head.phase_id}) mission=${head.mission_id}`);

const runDir = path.join(workbench, "runs", head.id);
const cpPath = path.join(runDir, "checkpoint.md");

function maybeAutoPushAfterVerify(runKind, head) {
  if (runKind !== "verify" || !head.mission_id) return Promise.resolve([]);
  return import("../orchestrator/dist/git-promote.js")
    .then(({ tryAutoGitPush }) =>
      tryAutoGitPush(workbench, {
        missionId: head.mission_id,
        phaseId: head.phase_id,
        verifyPassed: true,
      }),
    )
    .then((pushResults) => {
      for (const pr of pushResults) {
        if (pr.pushed) log(`git-push ${pr.repoId} → ${pr.commit}`);
        else if (pr.skipped) log(`git-push ${pr.repoId} skip: ${pr.skipped}`);
        else if (pr.error) log(`git-push ${pr.repoId} err: ${pr.error}`);
      }
      return pushResults;
    })
    .catch((e) => {
      log(`git-push skipped: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    });
}

async function tryAdvanceWithoutSpawn() {
  const runKind = readRunKind(workbench, head.id);
  if (finalizeRunCheckpoint(workbench, head.id, head.mission_id, runKind)) {
    log(`finalized checkpoint → runs/${head.id}/checkpoint.md`);
  }
  if (!existsSync(cpPath)) return false;

  const cp = checkpointTextForAdvance(workbench, head.id, head.mission_id);
  const action = evaluateCompletedRun(workbench, head.id, head.mission_id);
  if (action.action === "revise") {
    const fix = buildReviseImplementItem(head, Date.now(), action.mustFix ?? []);
    ({ now, backlog } = parseNowYaml(workbench));
    saveNowQueue(workbench, [fix, ...now.slice(1)], backlog);
    mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });
    log(`REVISE fix queued for ${head.phase_id}`);
    process.exit(0);
  }
  if (action.action !== "dequeue") {
    log(`not dequeue-ready: ${action.action} — ${advanceOnly ? "cannot advance-only" : "will respawn"}`);
    return false;
  }
  if (head.mission_id && head.phase_id && shouldMarkPhaseDone(runKind, cp)) {
    markMissionPhaseDone(workbench, head.mission_id, head.phase_id);
  }
  ({ now, backlog } = parseNowYaml(workbench));
  saveNowQueue(workbench, now.slice(1), backlog);
  mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });
  await maybeAutoPushAfterVerify(runKind, head);
  log(`done ${head.id} (advance-only)`);
  process.exit(0);
}

const { reconcileStaleApiInflight } = await import("../orchestrator/dist/api-gateway.js");
const clearedInflight = reconcileStaleApiInflight(workbench);
if (clearedInflight > 0) log(`reconciled stale api inflight (${clearedInflight})`);

if (advanceOnly || existsSync(cpPath)) {
  if (await tryAdvanceWithoutSpawn()) {
    /* exits inside */
  }
} else if (finalizeRunCheckpoint(workbench, head.id, head.mission_id, readRunKind(workbench, head.id))) {
  log(`synced checkpoint from events before spawn — retrying advance`);
  if (await tryAdvanceWithoutSpawn()) {
    /* exits inside */
  }
}

if (advanceOnly) {
  log("advance-only: checkpoint not dequeue-ready");
  process.exit(3);
}

const manifestPath = materializeQueueRun(head);
const spawnScript = path.join(repoRoot, "orchestrator", "dist", "spawn-run.js");
const r = spawnSync("node", [spawnScript, "--manifest", manifestPath], {
  cwd: repoRoot,
  env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench, JUNO_OVERSIGHT_ROOT: repoRoot },
  stdio: "inherit",
  shell: false,
  timeout: 45 * 60 * 1000,
});

if (r.error?.code === "ETIMEDOUT") {
  log("spawn-run timed out — try advance-only if checkpoint exists");
  if (await tryAdvanceWithoutSpawn()) {
    /* exits */
  }
  process.exit(1);
}

if ((r.status ?? 1) !== 0) {
  log(`spawn-run exit ${r.status}`);
  if (await tryAdvanceWithoutSpawn()) {
    /* exits */
  }
  process.exit(r.status ?? 1);
}

if (!existsSync(cpPath)) {
  const runKind = readRunKind(workbench, head.id);
  if (finalizeRunCheckpoint(workbench, head.id, head.mission_id, runKind)) {
    log(`synced checkpoint from events → runs/${head.id}/checkpoint.md`);
  }
}
if (!existsSync(cpPath)) {
  log("no checkpoint.md after live slot");
  process.exit(1);
}

const runKind = readRunKind(workbench, head.id);
if (finalizeRunCheckpoint(workbench, head.id, head.mission_id, runKind)) {
  log(`mirrored mission checkpoint → runs/${head.id}/checkpoint.md`);
}

const cp = checkpointTextForAdvance(workbench, head.id, head.mission_id);
let action = evaluateCompletedRun(workbench, head.id, head.mission_id);

if (action.action === "revise") {
  const fix = buildReviseImplementItem(head, Date.now(), action.mustFix ?? []);
  ({ now, backlog } = parseNowYaml(workbench));
  saveNowQueue(workbench, [fix, ...now.slice(1)], backlog);
  mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });
  log(`REVISE fix queued for ${head.phase_id}`);
  process.exit(0);
}

if (action.action !== "dequeue") {
  mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "failed" });
  log(`not dequeue-ready: ${action.action} — retry when review gate clears`);
  process.exit(3);
}

if (head.mission_id && head.phase_id && shouldMarkPhaseDone(runKind, cp)) {
  markMissionPhaseDone(workbench, head.mission_id, head.phase_id);
}

({ now, backlog } = parseNowYaml(workbench));
saveNowQueue(workbench, now.slice(1), backlog);
mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });
await maybeAutoPushAfterVerify(runKind, head);
log(`done ${head.id}`);
