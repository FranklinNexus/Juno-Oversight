#!/usr/bin/env node
/**
 * Axiom book loop — local planning + live chapter write/review.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  advanceOneBookSlot,
  spawnLiveBookSlot,
  writeBookLoopState,
  BOOK_MISSION_ID,
} from "./lib/book-advance-core.mjs";
import { countBookHan, needsLiveAgent } from "./lib/book-decision.mjs";
import { spawnPnpmWithTimeout } from "./lib/pnpm-runner.mjs";
import {
  BOOTSTRAP_TIMEOUT_MS,
  BUILD_TIMEOUT_MS,
  inspectMissionQueueHead,
  loopExitCode,
  parseCycleNonceFlag,
  parsePositiveIntegerFlag,
  requireSpawnSuccess,
  spawnWithTimeout,
  TERMINAL_BLOCK_EXIT,
} from "./lib/specialized-loop-guard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const skipAutonomy = process.argv.includes("--skip-autonomy");
const skipBuild = process.argv.includes("--skip-build");

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

function log(m) {
  process.stderr.write(`[book-loop] ${m}\n`);
}

let maxSlots;
let cycleNonce;
try {
  const args = process.argv.slice(2);
  maxSlots = parsePositiveIntegerFlag(args, "max-slots", 3, { max: 100 });
  cycleNonce = parseCycleNonceFlag(args);
} catch (error) {
  log(`BLOCKED: ${error.message}`);
  process.exit(TERMINAL_BLOCK_EXIT);
}

function writeLoopState(state) {
  writeBookLoopState(workbench, { ...state, cycleNonce });
}

if (!skipBuild) {
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
    writeLoopState({ status: "terminal_blocked", blockedReason: error.message });
    log(`BLOCKED: ${error.message}`);
    process.exit(TERMINAL_BLOCK_EXIT);
  }
}

try {
  const { loadProjectEnv } = await import("../orchestrator/dist/env.js");
  loadProjectEnv();

const deps = {
  queueIo: await import("../orchestrator/dist/queue-io.js"),
  manifest: await import("../orchestrator/dist/manifest.js"),
  missionProgress: await import("../orchestrator/dist/mission-progress.js"),
  missionCompletion: await import("../orchestrator/dist/mission-completion.js"),
  idempotency: await import("../orchestrator/dist/idempotency.js"),
};

const completionRecovery = deps.missionCompletion.recoverPendingVerifyCompletions(workbench);
if (completionRecovery.status === "busy") {
  writeLoopState({ status: "busy", blockedReason: "completion_recovery_busy" });
  process.exit(loopExitCode({ advanced: 0 }));
}
if (completionRecovery.status === "blocked") {
  writeLoopState({ status: "terminal_blocked", blockedReason: completionRecovery.reason });
  log(`BLOCKED: ${completionRecovery.reason}`);
  process.exit(TERMINAL_BLOCK_EXIT);
}
if (completionRecovery.status === "recovered") {
  deps.idempotency.mergeOrchestratorState(workbench, {
    activeRunId: null,
    activeRunStatus: "idle",
  });
  writeLoopState({ status: "idle", completionRecovery });
  log(`recovered completion ${completionRecovery.recovered.map((entry) => entry.terminalRunId).join(",")}`);
  process.exit(0);
}

let recordAutonomyDecision;
let decideNextAction;
if (!skipAutonomy) {
  ({ recordAutonomyDecision, decideNextAction } = await import("../orchestrator/dist/bounded-autonomy.js"));
  const decision = decideNextAction(workbench);
  if (decision.action === "escalate_human") {
    log(`BLOCKED: ${decision.reason}`);
    writeLoopState({ status: "terminal_blocked", decision });
    process.exit(TERMINAL_BLOCK_EXIT);
  }
  if (decision.action === "queue_mission") {
    if (decision.missionId !== BOOK_MISSION_ID || decision.bootstrap !== "queue:axiom-book") {
      writeLoopState({
        status: "terminal_blocked",
        blockedReason: `planner selected ${decision.missionId ?? "unknown"}`,
        decision,
      });
      log(`BLOCKED: planner selected another mission (${decision.missionId ?? "unknown"})`);
      process.exit(TERMINAL_BLOCK_EXIT);
    }
    try {
      requireSpawnSuccess(
        await spawnWithTimeout(process.execPath, ["scripts/bootstrap-axiom-book.mjs"], {
          cwd: repoRoot,
          stdio: "inherit",
          shell: false,
        }, BOOTSTRAP_TIMEOUT_MS),
        "axiom book bootstrap",
      );
    } catch (error) {
      writeLoopState({ status: "terminal_blocked", blockedReason: error.message });
      log(`BLOCKED: ${error.message}`);
      process.exit(TERMINAL_BLOCK_EXIT);
    }
  } else if (decision.action !== "run_book_loop" || decision.missionId !== BOOK_MISSION_ID) {
    writeLoopState({
      status: "terminal_blocked",
      blockedReason: `planner action ${decision.action} targets ${decision.missionId ?? "unknown"}`,
      decision,
    });
    log(`BLOCKED: planner selected ${decision.action} for ${decision.missionId ?? "unknown"}`);
    process.exit(TERMINAL_BLOCK_EXIT);
  }
  recordAutonomyDecision(workbench, {
    action: "run_book_loop",
    missionId: BOOK_MISSION_ID,
    script: "book:loop",
    reason: "axiom book advance",
  });
}

let advanced = 0;
let blocked = null;
let terminal = false;
let queueBusy = false;

for (let i = 0; i < maxSlots; i++) {
  const { readNowQueueSnapshot, replaceQueueSnapshotConditional } = deps.queueIo;
  const queueSnapshot = readNowQueueSnapshot(workbench);
  let { now, backlog } = queueSnapshot;
  if (now.length === 0) {
    const promoted = backlog.filter((item) => item.mission_id === BOOK_MISSION_ID).slice(0, 1);
    if (promoted.length === 0) break;
    const ids = new Set(promoted.map((p) => p.id));
    backlog = backlog.filter((item) => !ids.has(item.id));
    now = promoted;
    const promotion = replaceQueueSnapshotConditional(workbench, {
      expectedRevision: queueSnapshot.revision,
      now,
      backlog,
    });
    if (!promotion.ok) {
      if (promotion.reason === "busy") queueBusy = true;
      else {
        blocked = { reason: "queue_revision_conflict:backlog_promotion" };
        terminal = true;
      }
      break;
    }
  }
  const head = now[0];
  const headGuard = inspectMissionQueueHead(head, BOOK_MISSION_ID);
  if (!headGuard.ok) {
    if (headGuard.terminal) {
      blocked = { reason: headGuard.reason, phase: head?.phase_id };
      terminal = true;
      log(`blocked: ${headGuard.reason}`);
    }
    break;
  }
  if (String(head.phase_id ?? "").startsWith("bq-")) {
    blocked = { reason: `foreign_workflow_head:${head.phase_id}`, phase: head.phase_id };
    terminal = true;
    log(`blocked: ${blocked.reason}`);
    break;
  }

  if (needsLiveAgent(head)) {
    log(`live spawn ${head.id} (${head.phase_id})`);
    let live;
    try {
      live = await spawnLiveBookSlot(workbench, head, deps);
    } catch (error) {
      blocked = { reason: `live_exception:${error.message}`, phase: head.phase_id };
      terminal = true;
      log(`live failed: ${blocked.reason}`);
      break;
    }
    if (!live.ok) {
      if (live.busy) {
        log(`live queue mutation busy: ${live.reason}`);
        break;
      }
      blocked = { reason: live.reason, phase: head.phase_id };
      terminal = true;
      log(`live failed: ${live.reason}`);
      break;
    }
    if (live.dequeued) advanced += 1;
    log(live.revised ? `live revise transition ${head.id}` : `live dequeued ${head.id}`);
    continue;
  }

  let r;
  try {
    r = await advanceOneBookSlot(workbench, deps);
  } catch (error) {
    blocked = { reason: `advance_exception:${error.message}`, phase: head.phase_id };
    terminal = true;
    log(`blocked: ${blocked.reason}`);
    break;
  }
  if (r.advanced) {
    advanced += 1;
    log(`dequeued ${r.runId} (${r.runKind})`);
    continue;
  }
  if (r.needLive) {
    blocked = { reason: r.reason, phase: head.phase_id };
    terminal = true;
    break;
  }
  if (r.busy) {
    queueBusy = true;
    log(`stop: ${r.reason}`);
    break;
  }
  if (r.reason?.startsWith("unsupported_local:")) {
    blocked = { reason: r.reason, phase: head.phase_id };
    terminal = true;
    log(`blocked: ${r.reason}`);
    break;
  }
  log(`stop: ${r.reason}`);
  break;
}

const han = countBookHan(workbench);
writeLoopState({
  status: terminal
    ? "terminal_blocked"
    : blocked
      ? "blocked"
      : queueBusy
        ? "busy"
        : advanced > 0
          ? "idle"
          : "noop",
  slotsAdvancedThisRun: advanced,
  bookHanApprox: han,
  blockedReason: blocked?.reason ?? (queueBusy ? "queue_mutation_busy" : null),
  blockedPhase: blocked?.phase ?? null,
});

  log(`=== book:loop done — advanced ${advanced}, bookHan≈${han} ===`);
  process.exit(loopExitCode({ advanced, terminal: terminal || Boolean(blocked) }));
} catch (error) {
  writeLoopState({ status: "terminal_blocked", blockedReason: `loop_exception:${error.message}` });
  log(`BLOCKED: loop_exception:${error.message}`);
  process.exit(TERMINAL_BLOCK_EXIT);
}
