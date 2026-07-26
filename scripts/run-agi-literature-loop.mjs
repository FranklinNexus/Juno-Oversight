#!/usr/bin/env node
/**
 * AGI literature self-loop: advance slots until cap, missing batch, or verify slot.
 * Usage: node scripts/run-agi-literature-loop.mjs [--max-slots=20] [--skip-autonomy]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  advanceOneAgiSlot,
  countCompletedBatches,
  writeAgiLoopState,
  AGI_MISSION_ID,
} from "./lib/agi-advance-core.mjs";
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

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const skipAutonomy = process.argv.includes("--skip-autonomy");

function log(m) {
  process.stderr.write(`[agi-loop] ${m}\n`);
}

let maxSlots;
let cycleNonce;
try {
  const args = process.argv.slice(2);
  maxSlots = parsePositiveIntegerFlag(args, "max-slots", 20, { max: 200 });
  cycleNonce = parseCycleNonceFlag(args);
} catch (error) {
  log(`BLOCKED: ${error.message}`);
  process.exit(TERMINAL_BLOCK_EXIT);
}

function writeLoopState(state) {
  writeAgiLoopState(workbench, { ...state, cycleNonce });
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
  writeLoopState({ status: "terminal_blocked", blockedReason: error.message });
  log(`BLOCKED: ${error.message}`);
  process.exit(TERMINAL_BLOCK_EXIT);
}

try {
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
  ({ recordAutonomyDecision, decideNextAction } = await import(
    "../orchestrator/dist/bounded-autonomy.js"
  ));
  const decision = decideNextAction(workbench);
  if (decision.action === "escalate_human") {
    log(`BLOCKED: ${decision.reason} — ${decision.detail}`);
    writeLoopState({ status: "terminal_blocked", decision });
    process.exit(TERMINAL_BLOCK_EXIT);
  }
  if (decision.action === "queue_mission") {
    if (decision.missionId !== AGI_MISSION_ID || decision.bootstrap !== "queue:agi-literature") {
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
        await spawnWithTimeout(process.execPath, ["scripts/bootstrap-agi-literature.mjs"], {
          cwd: repoRoot,
          stdio: "inherit",
          shell: false,
        }, BOOTSTRAP_TIMEOUT_MS),
        "AGI literature bootstrap",
      );
    } catch (error) {
      writeLoopState({ status: "terminal_blocked", blockedReason: error.message });
      log(`BLOCKED: ${error.message}`);
      process.exit(TERMINAL_BLOCK_EXIT);
    }
  } else if (decision.action !== "run_agi_loop" || decision.missionId !== AGI_MISSION_ID) {
    writeLoopState({
      status: "terminal_blocked",
      blockedReason: `planner action ${decision.action} targets ${decision.missionId ?? "unknown"}`,
      decision,
    });
    log(`BLOCKED: planner selected ${decision.action} for ${decision.missionId ?? "unknown"}`);
    process.exit(TERMINAL_BLOCK_EXIT);
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
let terminal = false;
let queueBusy = false;

for (let i = 0; i < maxSlots; i++) {
  let r;
  try {
    r = await advanceOneAgiSlot(workbench, deps);
  } catch (error) {
    blocked = { reason: `advance_exception:${error.message}` };
    terminal = true;
    log(`blocked: ${blocked.reason}`);
    break;
  }
  if (r.advanced) {
    advanced += 1;
    log(`dequeued ${r.runId} (${r.runKind})`);
    continue;
  }
  if (r.blocked) {
    blocked = r;
    terminal = true;
    log(r.batchFile ? `blocked: ${r.reason} — write ${r.batchFile}` : `blocked: ${r.reason}`);
    break;
  }
  if (r.busy) {
    queueBusy = true;
    log(`stop: ${r.reason}`);
    break;
  }
  if (r.reason === "head_not_agi") {
    const { now } = deps.queueIo.parseNowYaml(workbench);
    const guard = inspectMissionQueueHead(now[0], AGI_MISSION_ID);
    blocked = { reason: guard.reason };
    terminal = true;
    log(`blocked: ${guard.reason}`);
    break;
  }
  log(`stop: ${r.reason}`);
  break;
}

const batches = countCompletedBatches(workbench);
const status = terminal
  ? "terminal_blocked"
  : blocked
    ? "blocked"
    : queueBusy
      ? "busy"
      : advanced > 0
        ? "idle"
        : "noop";

writeLoopState({
  status,
  slotsAdvancedThisRun: advanced,
  completedBatches: batches,
  papersApprox: batches * 25,
  blockedBatch: blocked?.batchFile ?? null,
  blockedReason: blocked?.reason ?? (queueBusy ? "queue_mutation_busy" : null),
});

  log(`=== agi:loop done — advanced ${advanced} slot(s), batches=${batches} (${batches * 25} papers) ===`);

  process.exit(loopExitCode({ advanced, terminal: terminal || Boolean(blocked) }));
} catch (error) {
  writeLoopState({ status: "terminal_blocked", blockedReason: `loop_exception:${error.message}` });
  log(`BLOCKED: loop_exception:${error.message}`);
  process.exit(TERMINAL_BLOCK_EXIT);
}
