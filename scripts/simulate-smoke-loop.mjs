#!/usr/bin/env node
/**
 * Dry simulation: materialize smoke-loop slots, evaluate gate actions, simulate dequeue.
 * Does NOT call Cursor API or start scheduler daemon.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCompletedRun } from "../orchestrator/dist/mission-progress.js";
import { materializeQueueRun } from "../orchestrator/dist/manifest.js";
import { validateReviewAlternation } from "../orchestrator/dist/review-loop.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

function parseNowYaml(text) {
  const now = [];
  let section = null;
  let item = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^now:\s*$/.test(line)) {
      section = "now";
      continue;
    }
    if (/^backlog:\s*$/.test(line)) {
      if (item && section === "now") now.push(item);
      item = null;
      section = "backlog";
      continue;
    }
    const head = line.match(/^\s{2}-\s+id:\s*(.+)$/);
    if (head && section === "now") {
      if (item) now.push(item);
      item = { id: head[1].trim() };
      continue;
    }
    if (!item || section !== "now") continue;
    const m = line.match(/^\s{4}([a-z_]+):\s*(.+)$/);
    if (!m) continue;
    const [, key, raw] = m;
    const val = raw.trim().replace(/^["']|["']$/g, "");
    if (key === "run_kind") item.run_kind = val;
    if (key === "kind") item.kind = val;
    if (key === "mission_id") item.mission_id = val;
    if (key === "phase_id") item.phase_id = val;
    if (key === "prompt") item.prompt = val;
    if (key === "provider") item.provider = val;
    if (key === "max_minutes") item.max_minutes = Number(val);
    if (key === "repo_target") item.repo_target = val;
    if (key === "horizon") item.horizon = val;
  }
  if (item) now.push(item);
  return now;
}

const checkpoints = {
  "juno-sl00-implement-ui-smoke": `# Checkpoint — sl00

STATUS: COMPLETE

## CHANGES
- scripts/ui-smoke.mjs (already present)
- package.json ui:smoke script
- wiki/smoke-loop.md
`,
  "juno-sl01-review-ui-smoke": `# Checkpoint — sl01

## REVIEW_VERDICT
- verdict: PASS
- drift: none
- scope_violations: []
- must_fix_next_slot: []
- reviewer_notes: ui-smoke scope OK, no functional edits in review slot
`,
  "juno-sl02-verify-smoke": `# Checkpoint — sl02

## VERIFY_REPORT
- test: PASS (pnpm test)
- check-orchestrator-deps: PASS
- ui_smoke: PASS (simulated)
- notes: dry-run simulation checkpoint
`,
};

const queuePath = path.join(workbench, "queue", "now.yaml");
const queueText = readFileSync(queuePath, "utf8");
const queue = parseNowYaml(queueText);

console.log("=== Smoke loop simulation ===\n");
console.log(`Queue head: ${queue.map((q) => q.id).join(" → ")}\n`);
console.log(`Alternation valid: ${validateReviewAlternation(queue)}\n`);

const results = [];
let simulatedQueue = [...queue];

for (const item of queue) {
  const runId = item.id;
  materializeQueueRun(item);
  const runDir = path.join(workbench, "runs", runId);
  writeFileSync(path.join(runDir, "checkpoint.md"), checkpoints[runId] ?? "# empty\n", "utf8");

  const action = evaluateCompletedRun(workbench, runId);
  const head = simulatedQueue[0];
  const headMatch = head?.id === runId;

  let dequeue = false;
  if (action.action === "dequeue") {
    if (item.run_kind === "implement") {
      dequeue = /STATUS:\s*COMPLETE/i.test(checkpoints[runId]);
    } else {
      dequeue = true;
    }
  }

  if (dequeue && headMatch) {
    simulatedQueue = simulatedQueue.slice(1);
  }

  results.push({
    slot: runId,
    runKind: item.run_kind,
    action: action.action,
    ...(action.action === "hold" ? { reason: action.reason } : {}),
    ...(action.action === "revise" ? { mustFix: action.mustFix } : {}),
    dequeueApplied: dequeue && headMatch,
    queueAfter: simulatedQueue[0]?.id ?? "(empty)",
  });
}

for (const r of results) {
  console.log(`[${r.slot}] kind=${r.runKind} → ${JSON.stringify(r)}`);
}

console.log("\n=== Summary ===");
const allDequeued = simulatedQueue.length === 0;
console.log(`Final queue: ${allDequeued ? "empty (3/3 passed gate)" : simulatedQueue.map((q) => q.id).join(", ")}`);
console.log(`Gate chain: ${results.every((r) => r.action === "dequeue" || r.action === "dequeue") ? "OK" : "CHECK"}`);

process.exit(allDequeued ? 0 : 1);
