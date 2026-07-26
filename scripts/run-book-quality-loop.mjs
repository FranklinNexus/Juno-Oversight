#!/usr/bin/env node
/**
 * Run book quality REVISE loop (live write/review with programmatic gates).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOK_MISSION_ID,
  spawnLiveBookSlot,
  writeBookQualityLoopState,
} from "./lib/book-advance-core.mjs";
import { needsLiveAgent } from "./lib/book-decision.mjs";
import { spawnPnpmWithTimeout } from "./lib/pnpm-runner.mjs";
import {
  BUILD_TIMEOUT_MS,
  inspectMissionQueueHead,
  loopExitCode,
  parseCycleNonceFlag,
  parsePositiveIntegerFlag,
  requireSpawnSuccess,
  TERMINAL_BLOCK_EXIT,
} from "./lib/specialized-loop-guard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

function log(m) {
  process.stderr.write(`[book-quality] ${m}\n`);
}

let maxSlots;
let cycleNonce;
try {
  const args = process.argv.slice(2);
  maxSlots = parsePositiveIntegerFlag(args, "max-slots", 2, { max: 100 });
  cycleNonce = parseCycleNonceFlag(args);
} catch (error) {
  log(`BLOCKED: ${error.message}`);
  process.exit(TERMINAL_BLOCK_EXIT);
}

function writeLoopState(state) {
  writeBookQualityLoopState(workbench, { ...state, cycleNonce });
}

try {
  requireSpawnSuccess(
    await spawnPnpmWithTimeout(
      ["orchestrator:build"],
      { cwd: repoRoot, stdio: "inherit" },
      BUILD_TIMEOUT_MS,
    ),
    "orchestrator build",
  );
} catch (error) {
  writeLoopState({
    status: "terminal_blocked",
    qualityLoop: true,
    blockedReason: error.message,
  });
  log(`BLOCKED: ${error.message}`);
  process.exit(TERMINAL_BLOCK_EXIT);
}

try {
  const { loadProjectEnv } = await import("../orchestrator/dist/env.js");
  loadProjectEnv();

const { autoFixBookSpacedBoldOnly, scanBookQuality } = await import(
  "../orchestrator/dist/quality-gate.js"
);
const preFix = autoFixBookSpacedBoldOnly(workbench, { strictLength: false });
const preFixed = preFix.filter((r) => r.fixed).length;
if (preFixed > 0) log(`programmatic fix: ${preFixed} chapters`);

const deps = {
  queueIo: await import("../orchestrator/dist/queue-io.js"),
  manifest: await import("../orchestrator/dist/manifest.js"),
  missionProgress: await import("../orchestrator/dist/mission-progress.js"),
  idempotency: await import("../orchestrator/dist/idempotency.js"),
};

function clearStaleBqQueue(scan) {
  if (scan.failedChapters.length > 0) return false;
  const { readNowQueueSnapshot, replaceQueueSnapshotConditional } = deps.queueIo;
  const queueSnapshot = readNowQueueSnapshot(workbench);
  const { now, backlog } = queueSnapshot;
  const stale = now.filter(
    (head) => head.mission_id === BOOK_MISSION_ID && /^bq-ch/.test(head.phase_id ?? ""),
  );
  if (stale.length === 0) return false;
  if (stale.length !== now.length) return false;
  const update = replaceQueueSnapshotConditional(workbench, {
    expectedRevision: queueSnapshot.revision,
    now: [],
    backlog,
  });
  if (!update.ok) return update.reason === "busy" ? "busy" : "conflict";
  log(`cleared ${stale.length} stale bq-* slots — scan PASS`);
  return true;
}

let scan = scanBookQuality(workbench, { strictLength: false });
const staleQueueResult = clearStaleBqQueue(scan);
if (staleQueueResult === "busy") {
  writeLoopState({ status: "busy", slotsAdvancedThisRun: 0, qualityLoop: true });
  process.exit(loopExitCode({ advanced: 0 }));
}
if (staleQueueResult === "conflict") {
  throw new Error("queue revision conflict while clearing stale book-quality work");
}
if (staleQueueResult) {
  writeLoopState({ status: "noop", slotsAdvancedThisRun: 0, qualityLoop: true, clearedStale: true });
  log("=== book:quality-loop done — stale queue cleared ===");
  process.exit(loopExitCode({ advanced: 0 }));
}

let advanced = 0;
let transitions = 0;
let failedReason = null;
let queueBusy = false;
for (let i = 0; i < maxSlots; i++) {
  const { parseNowYaml } = deps.queueIo;
  const { now } = parseNowYaml(workbench);
  const head = now[0];
  if (!head) break;
  const headGuard = inspectMissionQueueHead(head, BOOK_MISSION_ID, { phasePrefix: "bq-" });
  if (!headGuard.ok) {
    failedReason = headGuard.reason;
    log(`blocked: ${failedReason}`);
    break;
  }
  if (!needsLiveAgent(head)) {
    failedReason = `unsupported_quality_slot:${head.phase_id ?? "missing"}`;
    log(`blocked: ${failedReason}`);
    break;
  }

  log(`live ${head.id} (${head.phase_id})`);
  let live;
  try {
    live = await spawnLiveBookSlot(workbench, head, deps);
  } catch (error) {
    failedReason = `live_exception:${error.message}`;
    log(`failed: ${failedReason}`);
    break;
  }
  if (!live.ok) {
    if (live.busy) {
      queueBusy = true;
      log(`queue mutation busy: ${live.reason}`);
      break;
    }
    log(`failed: ${live.reason}`);
    failedReason = live.reason;
    break;
  }
  transitions += 1;
  if (live.dequeued) advanced += 1;
  log(live.revised ? `revise queued ${head.id}` : `done ${head.id}`);
}

if (advanced > 0) {
  try {
    const { runSelfOptimize } = await import("../orchestrator/dist/self-optimize.js");
    runSelfOptimize(workbench);
  } catch (error) {
    failedReason = `self_optimize:${error.message}`;
  }
}

scan = scanBookQuality(workbench, { strictLength: false });
const remaining = scan.failedChapters.length;
const terminal = Boolean(failedReason) || (!queueBusy && remaining > 0 && transitions === 0);

writeLoopState({
  status: terminal ? "terminal_blocked" : advanced > 0 ? "idle" : "noop",
  slotsAdvancedThisRun: advanced,
  transitionsThisRun: transitions,
  qualityLoop: true,
  remainingFailedChapters: remaining,
  blockedReason: failedReason ?? (terminal ? "quality_failures_without_progress" : null),
});

  log(`=== book:quality-loop done — advanced ${advanced}, remaining fail ${remaining || 0} ===`);
  process.exit(loopExitCode({ advanced, terminal }));
} catch (error) {
  writeLoopState({
    status: "terminal_blocked",
    qualityLoop: true,
    blockedReason: `quality_loop_exception:${error.message}`,
  });
  log(`BLOCKED: quality_loop_exception:${error.message}`);
  process.exit(TERMINAL_BLOCK_EXIT);
}
