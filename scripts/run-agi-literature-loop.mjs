#!/usr/bin/env node
/**
 * AGI literature self-loop: advance slots until cap, missing batch, or verify slot.
 * Usage: node scripts/run-agi-literature-loop.mjs [--max-slots=20] [--skip-autonomy]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  advanceOneAgiSlot,
  countCompletedBatches,
  writeAgiLoopState,
  AGI_MISSION_ID,
} from "./lib/agi-advance-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const maxArg = process.argv.find((a) => a.startsWith("--max-slots="));
const maxSlots = maxArg ? Number(maxArg.split("=")[1]) : 20;
const skipAutonomy = process.argv.includes("--skip-autonomy");

function log(m) {
  process.stderr.write(`[agi-loop] ${m}\n`);
}

const build = spawnSync("pnpm", ["orchestrator:build"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
});
if (build.status !== 0) process.exit(build.status ?? 1);

const deps = {
  queueIo: await import("../orchestrator/dist/queue-io.js"),
  manifest: await import("../orchestrator/dist/manifest.js"),
  missionProgress: await import("../orchestrator/dist/mission-progress.js"),
  idempotency: await import("../orchestrator/dist/idempotency.js"),
};

let recordAutonomyDecision;
let decideNextAction;
if (!skipAutonomy) {
  ({ recordAutonomyDecision, decideNextAction } = await import(
    "../orchestrator/dist/bounded-autonomy.js"
  ));
  const decision = decideNextAction(workbench);
  if (decision.action === "escalate_human") {
    log(`BLOCKED: ${decision.reason} — ${decision.detail}`);
    writeAgiLoopState(workbench, { status: "escalate_human", decision });
    process.exit(2);
  }
  if (decision.action === "queue_mission") {
    spawnSync("node", ["scripts/bootstrap-agi-literature.mjs"], { cwd: repoRoot, stdio: "inherit" });
  }
  recordAutonomyDecision(workbench, {
    action: "run_agi_loop",
    missionId: AGI_MISSION_ID,
    script: "agi:loop",
    reason: "bounded AGI literature advance loop",
  });
}

let advanced = 0;
let blocked = null;

for (let i = 0; i < maxSlots; i++) {
  const r = await advanceOneAgiSlot(workbench, deps);
  if (r.advanced) {
    advanced += 1;
    log(`dequeued ${r.runId} (${r.runKind})`);
    continue;
  }
  if (r.blocked) {
    blocked = r;
    log(`blocked: ${r.reason} — need Live implement slot or write ${r.batchFile}`);
    break;
  }
  log(`stop: ${r.reason}`);
  break;
}

const batches = countCompletedBatches(workbench);
const status = blocked ? "blocked_missing_batch" : advanced > 0 ? "idle" : "noop";

writeAgiLoopState(workbench, {
  status,
  slotsAdvancedThisRun: advanced,
  completedBatches: batches,
  papersApprox: batches * 25,
  blockedBatch: blocked?.batchFile ?? null,
});

log(`=== agi:loop done — advanced ${advanced} slot(s), batches=${batches} (${batches * 25} papers) ===`);

if (blocked && advanced === 0) process.exit(3);
process.exit(0);
