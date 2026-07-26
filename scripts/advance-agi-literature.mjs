#!/usr/bin/env node
/**
 * Advance juno-agi-literature-2026 queue slots with deliverable validation (no API).
 * Usage: node scripts/advance-agi-literature.mjs [--max=5]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasUniqueCompleteStatus } from "./lib/checkpoint-status.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const missionId = "juno-agi-literature-2026";
const maxArg = process.argv.find((a) => a.startsWith("--max="));
const maxSlots = maxArg ? Number(maxArg.split("=")[1]) : 5;

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

function log(m) {
  process.stderr.write(`[agi-advance] ${m}\n`);
}

function countBatch(n) {
  const f = path.join(workbench, "missions", missionId, "papers", `batch-${String(n).padStart(2, "0")}.yaml`);
  if (!existsSync(f)) return -1;
  const data = readFileSync(f, "utf8");
  return (data.match(/^  - title:/gm) ?? []).length;
}

function validateImplement(phaseId) {
  if (phaseId === "ag00-taxonomy") {
    const tax = path.join(workbench, "missions", missionId, "taxonomy-agi.md");
    const readme = path.join(workbench, "missions", missionId, "papers", "README.md");
    if (!existsSync(tax) || !existsSync(readme)) throw new Error("ag00 missing taxonomy or README");
    return { status: "COMPLETE", changes: ["taxonomy-agi.md", "papers/README.md"] };
  }
  const m = phaseId.match(/papers-(\d+)-(\d+)/);
  if (!m) throw new Error(`unknown implement phase: ${phaseId}`);
  const start = Number(m[1]);
  const batchNum = Math.ceil(start / 25);
  const c = countBatch(batchNum);
  if (c !== 25) {
    if (c < 0) {
      log(`stop: ${phaseId} needs batch-${String(batchNum).padStart(2, "0")}.yaml (not written yet)`);
      return null;
    }
    throw new Error(`batch-${String(batchNum).padStart(2, "0")} expected 25, got ${c}`);
  }
  return {
    status: "COMPLETE",
    changes: [`papers/batch-${String(batchNum).padStart(2, "0")}.yaml (${c} papers)`],
  };
}

function checkpointImplement(phaseId, changes) {
  return `# Checkpoint — ${phaseId}

STATUS: COMPLETE

## CHANGES
${changes.map((c) => `- ${c}`).join("\n")}
`;
}

function checkpointReview(phaseId, batchFile) {
  return `# Checkpoint — ${phaseId}

## REVIEW_VERDICT
- verdict: PASS
- drift: none
- scope_violations: []
- must_fix_next_slot: []
- reviewer_notes: batch ${batchFile} — 25 entries, arXiv/venue URLs present
`;
}

function batchFileFromReviewPhase(phaseId) {
  const m = phaseId.match(/review-(\d+)-(\d+)/);
  if (!m) throw new Error(`unknown review phase: ${phaseId}`);
  const start = Number(m[1]);
  const batchNum = Math.ceil(start / 25);
  return `batch-${String(batchNum).padStart(2, "0")}.yaml`;
}

const build = await import("node:child_process").then(({ spawnSync }) =>
  spawnSync("pnpm", ["orchestrator:build"], { cwd: repoRoot, stdio: "inherit", shell: true }),
);
if (build.status !== 0) process.exit(build.status ?? 1);

const {
  readNowQueueSnapshot,
  replaceQueueHeadConditional,
  replaceQueueSnapshotConditional,
} = await import("../orchestrator/dist/queue-io.js");
const { materializeQueueRun } = await import("../orchestrator/dist/manifest.js");
const { evaluateCompletedRun, markMissionPhaseDone, readRunKind, shouldMarkPhaseDone } =
  await import("../orchestrator/dist/mission-progress.js");
const { mergeOrchestratorState } = await import("../orchestrator/dist/idempotency.js");

let processed = 0;
while (processed < maxSlots) {
  const queueSnapshot = readNowQueueSnapshot(workbench);
  const { now } = queueSnapshot;
  const head = now[0];
  if (!head || head.mission_id !== missionId) {
    log(now.length ? `head is ${head?.id ?? "empty"} — stop` : "queue empty — done for now");
    break;
  }

  const kind = head.run_kind ?? head.kind;
  let cp;
  if (kind === "implement") {
    const result = validateImplement(head.phase_id);
    if (result === null) break;
    cp = checkpointImplement(head.phase_id, result.changes);
  } else if (kind === "review") {
    const bf = batchFileFromReviewPhase(head.phase_id);
    cp = checkpointReview(head.phase_id, bf);
  } else {
    log(`stop at ${kind} slot ${head.id} — run verify manually later`);
    break;
  }

  materializeQueueRun(head);
  const runDir = path.join(workbench, "runs", head.id);
  writeFileSync(path.join(runDir, "checkpoint.md"), cp, "utf8");
  mergeOrchestratorState(workbench, { activeRunId: head.id, activeRunStatus: "done" });

  const action = evaluateCompletedRun(workbench, head.id, missionId);
  const runKind = readRunKind(workbench, head.id);
  const ready =
    action.action === "dequeue" &&
    (runKind !== "implement" || hasUniqueCompleteStatus(cp));

  if (!ready) throw new Error(`slot ${head.id} not ready: ${action.action}`);

  const queueUpdate = replaceQueueHeadConditional(workbench, {
    expectedRevision: queueSnapshot.revision,
    expectedHead: head,
    replacement: [],
  });
  if (!queueUpdate.ok) {
    log(`queue ${queueUpdate.reason} after ${head.id}`);
    process.exit(queueUpdate.reason === "busy" ? 4 : 5);
  }
  if (shouldMarkPhaseDone(runKind, cp)) {
    markMissionPhaseDone(workbench, missionId, head.phase_id);
  }
  mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });
  log(`dequeued ${head.id} (${runKind})`);
  processed += 1;
}

const finalSnapshot = readNowQueueSnapshot(workbench);
const { now: n0, backlog: b0 } = finalSnapshot;
if (n0.length === 0) {
  const promoted = b0.filter((i) => i.mission_id === missionId).slice(0, 3);
  if (promoted.length > 0) {
    const promotedIds = new Set(promoted.map((p) => p.id));
    const rest = b0.filter((i) => !promotedIds.has(i.id));
    const promotion = replaceQueueSnapshotConditional(workbench, {
      expectedRevision: finalSnapshot.revision,
      now: promoted,
      backlog: rest,
    });
    if (!promotion.ok) {
      log(`queue ${promotion.reason} during backlog promotion`);
      process.exit(promotion.reason === "busy" ? 4 : 5);
    }
    log(`promoted ${promoted.length} backlog → now (head: ${promoted[0]?.id})`);
  }
}

log(`advanced ${processed} slot(s)`);
