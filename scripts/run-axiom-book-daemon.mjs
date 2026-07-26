#!/usr/bin/env node
/** Background daemon for axiom book mission — respects API gateway backoff. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOK_MISSION_ID,
  CHAPTER_COUNT,
  countBookHan,
  validateBookCompletionEvidence,
} from "./lib/book-decision.mjs";
import { hasUniqueCompleteStatus } from "./lib/checkpoint-status.mjs";
import { spawnPnpmWithTimeout } from "./lib/pnpm-runner.mjs";
import {
  acquirePidFile,
  BUILD_TIMEOUT_MS,
  checkedSpawnStatus,
  completionEvidenceReady,
  daemonCycleTimeoutMs,
  liveSlotTimeoutMs,
  daemonFailureIsTerminal,
  inspectDaemonRestartState,
  nextConsecutiveFailureCount,
  parsePositiveIntegerFlag,
  releasePidFile,
  requireSpawnSuccess,
  spawnWithTimeout,
  stateWriteIsFresh,
  TERMINAL_BLOCK_EXIT,
} from "./lib/specialized-loop-guard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
let intervalMs;
let maxSlots;
let maxConsecutiveFailures;
const args = process.argv.slice(2);
try {
  intervalMs = parsePositiveIntegerFlag(args, "interval-ms", 120_000, {
    min: 100,
    max: 86_400_000,
  });
  maxSlots = parsePositiveIntegerFlag(args, "max-slots", 3, { max: 100 });
  maxConsecutiveFailures = parsePositiveIntegerFlag(args, "max-consecutive-failures", 3, {
    max: 20,
  });
} catch (error) {
  process.stderr.write(`[book-daemon] BLOCKED: ${error.message}\n`);
  process.exit(TERMINAL_BLOCK_EXIT);
}

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
  process.stderr.write(`[book-daemon] BLOCKED: ${error.message}\n`);
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
    `[book-daemon] BLOCKED: mission receipt verifier is unavailable; run orchestrator:build (${error.message})\n`,
  );
  process.exit(TERMINAL_BLOCK_EXIT);
}

const pidPath = path.join(workbench, "state", "book-daemon.pid");
const statePath = path.join(workbench, "state", "book-daemon.json");
mkdirSync(path.join(workbench, "state"), { recursive: true });

function log(m) {
  process.stderr.write(`[book-daemon] ${m}\n`);
}

function writeDaemonState(patch) {
  let previous = {};
  if (existsSync(statePath)) {
    try {
      previous = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      previous = {};
    }
  }
  writeFileSync(
    statePath,
    `${JSON.stringify({
      ...previous,
      ...patch,
      pid: process.pid,
      pidLeaseToken: pidLease?.token ?? null,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
}

function missionCompletionEvidence() {
  const cp = path.join(workbench, "missions", BOOK_MISSION_ID, "checkpoint.md");
  const checkpointComplete = existsSync(cp) && hasUniqueCompleteStatus(readFileSync(cp, "utf8"));
  const domainEvidence = validateBookCompletionEvidence(workbench);
  const completedChapters = domainEvidence.completedChapters;
  const artifactsReady = domainEvidence.ok;
  let receiptReady = false;
  let receiptState = "missing";
  let receiptReason = null;
  try {
    receiptReady = readMissionCompletionReceipt(workbench, BOOK_MISSION_ID) !== null;
    receiptState = receiptReady ? "valid" : "missing";
    if (!receiptReady) receiptReason = "missing trusted mission completion receipt";
  } catch (error) {
    receiptState = "invalid";
    receiptReason = `invalid mission completion receipt: ${error.message}`;
  }
  return {
    ready: completionEvidenceReady({
      checkpointComplete,
      completedUnits: completedChapters,
      requiredUnits: CHAPTER_COUNT,
      artifactsReady: artifactsReady && receiptReady,
    }),
    checkpointComplete,
    completedChapters,
    artifactsReady,
    receiptReady,
    receiptState,
    evidenceReason:
      domainEvidence.reason
      ?? (!checkpointComplete ? "mission checkpoint is not uniquely COMPLETE" : null)
      ?? receiptReason,
  };
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

async function loadGateway() {
  return import("../orchestrator/dist/api-gateway.js");
}

function backoffSleepMs(gateway) {
  const rows = gateway.getQuotaStatus(workbench);
  const codex = rows.find((r) => r.providerId === "openai");
  if (!codex?.backoffUntil) return 0;
  const until = Date.parse(codex.backoffUntil);
  if (Number.isNaN(until)) return 0;
  return Math.min(86_400_000, Math.max(0, until - Date.now() + 2000));
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

let consecutiveFailures = 0;
let finalStatus = "stopped";
let pidReleased = false;
let restartGate;
try {
  restartGate = inspectDaemonRestartState(statePath, args);
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
restartGate = inspectDaemonRestartState(statePath, args);
if (!restartGate.allowed && !completionRecovered) {
  releasePidFile(pidPath, pidLease);
  log(`BLOCKED: explicit --unblock-daemon required (${restartGate.reason})`);
  process.exit(TERMINAL_BLOCK_EXIT);
}
const shutdownController = new AbortController();
let stopSignal = null;

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
  log(`${signal} - shutting down`);
  shutdownController.abort();
  writeDaemonState({ status: finalStatus });
}

process.once("SIGINT", () => stopForSignal("SIGINT"));
process.once("SIGTERM", () => stopForSignal("SIGTERM"));
process.once("exit", releasePid);

log(`started pid=${process.pid} interval=${intervalMs}ms max-slots=${maxSlots}`);
writeDaemonState({
  status: "running",
  startedAt: new Date().toISOString(),
  intervalMs,
  maxSlots,
  maxConsecutiveFailures,
  blockedReason: null,
  evidenceReason: null,
  terminalAt: null,
  stoppedAt: null,
  consecutiveFailures: 0,
  unblockedAt: restartGate.unblocked ? new Date().toISOString() : null,
});

let gateway;
const startupCompletion = missionCompletionEvidence();
if (
  !startupCompletion.ready
  && (startupCompletion.checkpointComplete || startupCompletion.receiptState !== "missing")
) {
  finalStatus = "terminal_blocked";
  writeDaemonState({
    status: finalStatus,
    blockedReason: `invalid_complete_checkpoint:${startupCompletion.evidenceReason ?? "incomplete evidence"}`,
    evidenceReason: startupCompletion.evidenceReason,
    completedChapters: startupCompletion.completedChapters,
    bookHan: countBookHan(workbench),
    terminalAt: new Date().toISOString(),
    artifactsReady: startupCompletion.artifactsReady,
    receiptState: startupCompletion.receiptState,
  });
  log("BLOCKED: mission checkpoint claims COMPLETE without full deterministic evidence");
  releasePid();
  process.exit(TERMINAL_BLOCK_EXIT);
}
if (startupCompletion.ready) {
  finalStatus = "complete";
  writeDaemonState({
    status: finalStatus,
    bookHan: countBookHan(workbench),
    completedChapters: startupCompletion.completedChapters,
    blockedReason: null,
    evidenceReason: null,
    artifactsReady: true,
    terminalAt: null,
    consecutiveFailures: 0,
  });
  releasePid();
  process.exit(0);
}
try {
  gateway = await loadGateway();
} catch (error) {
  finalStatus = "terminal_blocked";
  writeDaemonState({
    status: finalStatus,
    blockedReason: error.message,
    terminalAt: new Date().toISOString(),
  });
  log(`BLOCKED: ${error.message}`);
  releasePid();
  process.exit(TERMINAL_BLOCK_EXIT);
}

while (true) {
  if (stopSignal) {
    finalStatus = "stopped";
    writeDaemonState({ status: finalStatus, stoppedAt: new Date().toISOString() });
    break;
  }
  const completion = missionCompletionEvidence();
  if (!completion.ready && (completion.checkpointComplete || completion.receiptState !== "missing")) {
    finalStatus = "terminal_blocked";
    writeDaemonState({
      status: finalStatus,
      blockedReason: `invalid_complete_checkpoint:${completion.evidenceReason ?? "incomplete evidence"}`,
      evidenceReason: completion.evidenceReason,
      completedChapters: completion.completedChapters,
      bookHan: countBookHan(workbench),
      terminalAt: new Date().toISOString(),
      artifactsReady: completion.artifactsReady,
      receiptState: completion.receiptState,
    });
    log("BLOCKED: mission checkpoint claims COMPLETE without full deterministic evidence");
    process.exitCode = TERMINAL_BLOCK_EXIT;
    break;
  }
  if (completion.ready) {
    finalStatus = "complete";
    writeDaemonState({
      status: finalStatus,
      bookHan: countBookHan(workbench),
      completedChapters: completion.completedChapters,
      blockedReason: null,
      evidenceReason: null,
      artifactsReady: true,
      terminalAt: null,
      consecutiveFailures: 0,
    });
    log("mission COMPLETE — exit");
    break;
  }

  let backoffMs;
  try {
    backoffMs = backoffSleepMs(gateway);
  } catch (error) {
    consecutiveFailures += 1;
    const terminal = daemonFailureIsTerminal(false, consecutiveFailures, maxConsecutiveFailures);
    writeDaemonState({
      status: terminal ? "terminal_blocked" : "retrying",
      blockedReason: `quota_status:${error.message}`,
      consecutiveFailures,
      terminalAt: terminal ? new Date().toISOString() : null,
    });
    if (terminal) {
      finalStatus = "terminal_blocked";
      log(`BLOCKED: quota status failed ${consecutiveFailures} consecutive times`);
      process.exitCode = TERMINAL_BLOCK_EXIT;
      break;
    }
    await sleep(intervalMs, shutdownController.signal);
    continue;
  }
  if (backoffMs > 0) {
    log(`API backoff — sleep ${Math.round(backoffMs / 1000)}s`);
    await sleep(backoffMs, shutdownController.signal);
  }
  if (stopSignal) continue;

  const loopStatePath = path.join(workbench, "state", "book-loop.json");
  const previousLoopState = existsSync(loopStatePath) ? readFileSync(loopStatePath, "utf8") : null;
  const cycleNonce = randomUUID();
  const tick = await spawnWithTimeout(process.execPath, [
    "scripts/run-axiom-book-loop.mjs",
    `--max-slots=${maxSlots}`,
    `--cycle-nonce=${cycleNonce}`,
    "--skip-autonomy",
    "--skip-build",
  ], {
    cwd: repoRoot,
    stdio: "inherit",
    signal: shutdownController.signal,
    shell: false,
  }, daemonCycleTimeoutMs(maxSlots, liveSlotTimeoutMs(240)));
  if (stopSignal) {
    finalStatus = "stopped";
    writeDaemonState({ status: finalStatus, stoppedAt: new Date().toISOString() });
    break;
  }

  let tickStatus;
  let tickError = null;
  try {
    tickStatus = checkedSpawnStatus(tick, "axiom book loop");
  } catch (error) {
    tickStatus = 1;
    tickError = error.message;
  }

  let loopState = {};
  let currentLoopState = null;
  if (existsSync(loopStatePath)) {
    try {
      currentLoopState = readFileSync(loopStatePath, "utf8");
      loopState = JSON.parse(currentLoopState);
    } catch {
      loopState = {};
    }
  }
  if (!stateWriteIsFresh(previousLoopState, currentLoopState, loopState, cycleNonce)) {
    loopState = { status: "missing_cycle_state" };
  }
  const advanced = Number.isSafeInteger(loopState.slotsAdvancedThisRun)
    && loopState.slotsAdvancedThisRun > 0
    ? loopState.slotsAdvancedThisRun
    : 0;
  let quota = null;
  try {
    quota = gateway.getQuotaStatus(workbench).find((r) => r.providerId === "openai") ?? null;
  } catch (error) {
    tickError ??= `quota_status:${error.message}`;
    if (tickStatus === 0) tickStatus = 1;
  }
  if (loopState.status !== "busy") {
    consecutiveFailures = nextConsecutiveFailureCount(consecutiveFailures, {
      exitCode: tickStatus,
      advanced,
    });
  }
  const explicitTerminal =
    tick.timedOut
    || tick.terminationConfirmed === false
    || tickStatus === TERMINAL_BLOCK_EXIT
    || loopState.status === "terminal_blocked";
  const blockedReason =
    loopState.blockedReason
    ?? tickError
    ?? (tickStatus === 4 ? "loop_noop" : `loop_exit_${tickStatus}`);
  writeDaemonState({
    status: explicitTerminal ? "terminal_blocked" : consecutiveFailures > 0 ? "retrying" : "running",
    lastExit: tickStatus,
    lastAdvanced: advanced,
    consecutiveFailures,
    blockedReason: consecutiveFailures > 0 ? blockedReason : null,
    bookHan: countBookHan(workbench),
    api: quota
      ? { rpm: quota.rpm, dailyRequests: quota.dailyRequests, backoffUntil: quota.backoffUntil }
      : null,
  });

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

  await sleep(intervalMs, shutdownController.signal);
}

releasePid();
