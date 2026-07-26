#!/usr/bin/env node
/**
 * AGI literature daemon — continuous local advance without Cursor window.
 * Runs agi:loop in a cycle until mission complete, daily cap, or fatal error.
 *
 * Usage:
 *   node scripts/run-agi-literature-daemon.mjs [--interval-ms=30000] [--max-slots=40]
 *   pnpm agi:daemon
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGI_MISSION_ID,
  countCompletedBatches,
  validateAgiLiteratureEvidence,
} from "./lib/agi-advance-core.mjs";
import { hasUniqueCompleteStatus } from "./lib/checkpoint-status.mjs";
import { spawnPnpmWithTimeout } from "./lib/pnpm-runner.mjs";
import {
  acquirePidFile,
  BUILD_TIMEOUT_MS,
  checkedSpawnStatus,
  completionEvidenceReady,
  daemonCycleTimeoutMs,
  daemonFailureIsTerminal,
  inspectDaemonRestartState,
  nextConsecutiveFailureCount,
  parsePositiveIntegerFlag,
  releasePidFile,
  requireSpawnSuccess,
  spawnWithTimeout,
  startDaemonStateHeartbeat,
  stateWriteIsFresh,
  TERMINAL_BLOCK_EXIT,
  VERIFY_TIMEOUT_MS,
} from "./lib/specialized-loop-guard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

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
  process.stderr.write(`[agi-daemon] BLOCKED: ${error.message}\n`);
  process.exit(TERMINAL_BLOCK_EXIT);
}

let readMissionCompletionReceipt;
let recoverPendingVerifyCompletions;
try {
  ({ readMissionCompletionReceipt, recoverPendingVerifyCompletions } = await import(
    "../orchestrator/dist/mission-completion.js"
  ));
} catch (error) {
  process.stderr.write(
    `[agi-daemon] BLOCKED: mission receipt verifier is unavailable; run orchestrator:build (${error.message})\n`,
  );
  process.exit(TERMINAL_BLOCK_EXIT);
}

let intervalMs;
let maxSlots;
let maxConsecutiveFailures;
const args = process.argv.slice(2);
try {
  intervalMs = parsePositiveIntegerFlag(args, "interval-ms", 30_000, { min: 100, max: 86_400_000 });
  maxSlots = parsePositiveIntegerFlag(args, "max-slots", 40, { max: 200 });
  maxConsecutiveFailures = parsePositiveIntegerFlag(args, "max-consecutive-failures", 3, {
    max: 20,
  });
} catch (error) {
  process.stderr.write(`[agi-daemon] BLOCKED: ${error.message}\n`);
  process.exit(TERMINAL_BLOCK_EXIT);
}
const retryDelayMs = Math.max(intervalMs, 5_000);

const stateDir = path.join(workbench, "state");
const pidPath = path.join(stateDir, "agi-daemon.pid");
const daemonStatePath = path.join(stateDir, "agi-daemon.json");

mkdirSync(stateDir, { recursive: true });

function log(msg) {
  const line = `[agi-daemon] ${msg}\n`;
  process.stderr.write(line);
}

function writeDaemonState(patch) {
  let prev = {};
  if (existsSync(daemonStatePath)) {
    try {
      prev = JSON.parse(readFileSync(daemonStatePath, "utf8"));
    } catch {
      prev = {};
    }
  }
  writeFileSync(
    daemonStatePath,
    `${JSON.stringify({
      ...prev,
      ...patch,
      pid: process.pid,
      pidLeaseToken: pidLease?.token ?? null,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
}

function missionCompletionEvidence() {
  const cp = path.join(workbench, "missions", AGI_MISSION_ID, "checkpoint.md");
  const checkpointComplete = existsSync(cp) && hasUniqueCompleteStatus(readFileSync(cp, "utf8"));
  const domainEvidence = validateAgiLiteratureEvidence(workbench);
  const completedBatches = domainEvidence.completedBatches;
  const artifactsReady = domainEvidence.ok;
  let receiptReady = false;
  let receiptState = "missing";
  let receiptReason = null;
  try {
    receiptReady = readMissionCompletionReceipt(workbench, AGI_MISSION_ID) !== null;
    receiptState = receiptReady ? "valid" : "missing";
    if (!receiptReady) receiptReason = "missing trusted mission completion receipt";
  } catch (error) {
    receiptState = "invalid";
    receiptReason = `invalid mission completion receipt: ${error.message}`;
  }
  return {
    ready: completionEvidenceReady({
      checkpointComplete,
      completedUnits: completedBatches,
      requiredUnits: 40,
      artifactsReady: artifactsReady && receiptReady,
    }),
    checkpointComplete,
    completedBatches,
    artifactsReady,
    receiptReady,
    receiptState,
    evidenceReason:
      domainEvidence.reason
      ?? (!checkpointComplete ? "mission checkpoint is not uniquely COMPLETE" : null)
      ?? receiptReason,
  };
}

let completionRecovered = false;
try {
  const recovery = recoverPendingVerifyCompletions(workbench);
  if (recovery.status === "busy") {
    log("completion recovery busy");
    process.exit(4);
  }
  if (recovery.status === "blocked") {
    log(`BLOCKED: ${recovery.reason}`);
    process.exit(TERMINAL_BLOCK_EXIT);
  }
  completionRecovered = recovery.status === "recovered";
} catch (error) {
  log(`BLOCKED: invalid completion recovery state: ${error.message}`);
  process.exit(TERMINAL_BLOCK_EXIT);
}

let restartGate;
try {
  restartGate = inspectDaemonRestartState(daemonStatePath, args);
} catch (error) {
  log(`BLOCKED: ${error.message}`);
  process.exit(TERMINAL_BLOCK_EXIT);
}
if (!restartGate.allowed && !completionRecovered) {
  log(`BLOCKED: explicit --unblock-daemon required (${restartGate.reason})`);
  process.exit(TERMINAL_BLOCK_EXIT);
}

let pidLease;
try {
  pidLease = acquirePidFile(pidPath);
} catch (error) {
  log(`BLOCKED: ${error.message}`);
  process.exit(TERMINAL_BLOCK_EXIT);
}
restartGate = inspectDaemonRestartState(daemonStatePath, args);
if (!restartGate.allowed && !completionRecovered) {
  releasePidFile(pidPath, pidLease);
  log(`BLOCKED: explicit --unblock-daemon required (${restartGate.reason})`);
  process.exit(TERMINAL_BLOCK_EXIT);
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      signal?.removeEventListener("abort", finish);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

const shutdownController = new AbortController();
let stopSignal = null;

async function runLoopOnce(cycleNonce) {
  const r = await spawnWithTimeout(
    process.execPath,
    [
      "scripts/run-agi-literature-loop.mjs",
      `--max-slots=${maxSlots}`,
      `--cycle-nonce=${cycleNonce}`,
      "--skip-autonomy",
    ],
    { cwd: repoRoot, encoding: "utf8", signal: shutdownController.signal },
    daemonCycleTimeoutMs(maxSlots, VERIFY_TIMEOUT_MS),
  );
  try {
    return {
      status: checkedSpawnStatus(r, "AGI literature loop"),
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      error: null,
      timedOut: r.timedOut,
      terminationConfirmed: r.terminationConfirmed,
    };
  } catch (error) {
    return {
      status: 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      error: error.message,
      timedOut: r.timedOut,
      terminationConfirmed: r.terminationConfirmed,
    };
  }
}

let cycles = 0;
let totalSlots = 0;
let consecutiveFailures = 0;
let finalStatus = "stopped";
let pidReleased = false;

function releasePid() {
  if (pidReleased) return;
  try {
    releasePidFile(pidPath, pidLease);
    pidReleased = true;
  } catch (error) {
    log(`pid cleanup failed: ${error.message}`);
  }
}

function stopForSignal(signal) {
  if (stopSignal) return;
  stopSignal = signal;
  finalStatus = "stopping";
  log(`${signal} — shutting down`);
  shutdownController.abort();
  writeDaemonState({
    status: finalStatus,
    activeCycleNonce: null,
  });
}

process.once("SIGINT", () => stopForSignal("SIGINT"));
process.once("SIGTERM", () => stopForSignal("SIGTERM"));
process.once("exit", releasePid);

writeDaemonState({
  status: "running",
  startedAt: new Date().toISOString(),
  intervalMs,
  maxSlots,
  maxConsecutiveFailures,
  retryDelayMs,
  blockedReason: null,
  blockedBatch: null,
  evidenceReason: null,
  terminalAt: null,
  stoppedAt: null,
  activeCycleNonce: null,
  consecutiveFailures: 0,
  unblockedAt: restartGate.unblocked ? new Date().toISOString() : null,
});

log(`started pid=${process.pid} interval=${intervalMs}ms max-slots=${maxSlots}`);

while (true) {
  if (stopSignal) {
    finalStatus = "stopped";
    writeDaemonState({
      status: finalStatus,
      stoppedAt: new Date().toISOString(),
      activeCycleNonce: null,
    });
    break;
  }
  cycles += 1;

  const completion = missionCompletionEvidence();
  if (!completion.ready && (completion.checkpointComplete || completion.receiptState !== "missing")) {
    finalStatus = "terminal_blocked";
    writeDaemonState({
      status: finalStatus,
      blockedReason: `invalid_complete_checkpoint:${completion.evidenceReason ?? "incomplete evidence"}`,
      evidenceReason: completion.evidenceReason,
      completedBatches: completion.completedBatches,
      papersApprox: completion.completedBatches * 25,
      artifactsReady: completion.artifactsReady,
      receiptState: completion.receiptState,
      terminalAt: new Date().toISOString(),
      cycles,
      totalSlots,
    });
    log("BLOCKED: mission checkpoint claims COMPLETE without full deterministic evidence");
    process.exitCode = TERMINAL_BLOCK_EXIT;
    break;
  }
  if (completion.ready) {
    finalStatus = "complete";
    log("mission COMPLETE — daemon exiting");
    writeDaemonState({
      status: finalStatus,
      cycles,
      totalSlots,
      completedBatches: completion.completedBatches,
      papersApprox: completion.completedBatches * 25,
      blockedReason: null,
      evidenceReason: null,
      artifactsReady: true,
      terminalAt: null,
      consecutiveFailures: 0,
    });
    break;
  }

  const agiLoopPath = path.join(stateDir, "agi-loop.json");
  const previousLoopState = existsSync(agiLoopPath) ? readFileSync(agiLoopPath, "utf8") : null;
  const cycleNonce = randomUUID();
  let cycleHeartbeatError = null;
  const stopCycleHeartbeat = startDaemonStateHeartbeat(
    () => writeDaemonState({
      heartbeatAt: new Date().toISOString(),
      activeCycleNonce: cycleNonce,
    }),
    {
      signal: shutdownController.signal,
      onError: (error) => {
        cycleHeartbeatError = error;
        shutdownController.abort();
      },
    },
  );
  let loopResult;
  try {
    loopResult = await runLoopOnce(cycleNonce);
  } finally {
    stopCycleHeartbeat();
  }
  if (stopSignal) {
    finalStatus = "stopped";
    writeDaemonState({
      status: finalStatus,
      stoppedAt: new Date().toISOString(),
      activeCycleNonce: null,
    });
    break;
  }
  const { status } = loopResult;
  const batches = countCompletedBatches(workbench);
  const papers = batches * 25;

  let agiLoop = {};
  let currentLoopState = null;
  if (existsSync(agiLoopPath)) {
    try {
      currentLoopState = readFileSync(agiLoopPath, "utf8");
      agiLoop = JSON.parse(currentLoopState);
    } catch {
      agiLoop = {};
    }
  }

  const freshLoopState = stateWriteIsFresh(
    previousLoopState,
    currentLoopState,
    agiLoop,
    cycleNonce,
  );
  if (!freshLoopState) agiLoop = { status: "missing_cycle_state" };
  const advanced = Number.isSafeInteger(agiLoop.slotsAdvancedThisRun)
    && agiLoop.slotsAdvancedThisRun > 0
    ? agiLoop.slotsAdvancedThisRun
    : 0;
  totalSlots += advanced;
  if (agiLoop.status !== "busy") {
    consecutiveFailures = nextConsecutiveFailureCount(consecutiveFailures, {
      exitCode: status,
      advanced,
    });
  }

  const explicitTerminal =
    cycleHeartbeatError !== null
    || loopResult.timedOut
    || loopResult.terminationConfirmed === false
    || status === TERMINAL_BLOCK_EXIT
    || status === 2
    || ["terminal_blocked", "blocked_missing_batch", "escalate_human"].includes(agiLoop.status);
  const blockedReason =
    (cycleHeartbeatError
      ? `daemon_heartbeat:${cycleHeartbeatError instanceof Error ? cycleHeartbeatError.message : String(cycleHeartbeatError)}`
      : null)
    ?? agiLoop.blockedReason
    ?? agiLoop.blockedBatch
    ?? loopResult.error
    ?? (status === 4 ? "loop_noop" : `loop_exit_${status}`);

  writeDaemonState({
    status: explicitTerminal ? "terminal_blocked" : consecutiveFailures > 0 ? "retrying" : "running",
    cycles,
    totalSlots,
    consecutiveFailures,
    completedBatches: batches,
    papersApprox: papers,
    blockedBatch: agiLoop.blockedBatch ?? null,
    blockedReason: consecutiveFailures > 0 ? blockedReason : null,
    lastExitCode: status,
    lastCycleAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    activeCycleNonce: null,
  });

  log(`cycle ${cycles}: advanced=${advanced} batches=${batches} (${papers} papers) exit=${status}`);

  if (daemonFailureIsTerminal(explicitTerminal, consecutiveFailures, maxConsecutiveFailures)) {
    finalStatus = "terminal_blocked";
    writeDaemonState({
      status: finalStatus,
      blockedReason,
      consecutiveFailures,
      terminalAt: new Date().toISOString(),
    });
    log(`BLOCKED: ${blockedReason}; consecutive failures=${consecutiveFailures}`);
    process.exitCode = TERMINAL_BLOCK_EXIT;
    break;
  }

  await sleep(
    consecutiveFailures > 0 ? retryDelayMs : intervalMs,
    shutdownController.signal,
  );
}

releasePid();
log("daemon exited");
