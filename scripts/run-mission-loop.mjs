#!/usr/bin/env node
/**
 * Generic mission loop - spawn one Live slot from queue head (hardening, etc.).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpmWithTimeout } from "./lib/pnpm-runner.mjs";
import {
  BUILD_TIMEOUT_MS,
  checkedSpawnStatus,
  spawnWithTimeout,
} from "./lib/specialized-loop-guard.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

export const DEFAULT_RUN_MAX_RETRIES = 3;
export const MAX_RUN_MAX_RETRIES = 20;
export const MAX_MANIFEST_RUN_MINUTES = 240;
export const LIVE_SLOT_TIMEOUT_GRACE_MS = 5 * 60_000;
export const MAX_MISSION_LIVE_TIMEOUT_MS =
  MAX_MANIFEST_RUN_MINUTES * 60_000 + LIVE_SLOT_TIMEOUT_GRACE_MS;
export const MISSION_NO_PROGRESS_EXIT_CODE = 4;

export function isMissionNoProgressExit(exitCode) {
  return exitCode === MISSION_NO_PROGRESS_EXIT_CODE;
}

function log(message) {
  process.stderr.write(`[mission-loop] ${message}\n`);
}

export function validateRunId(runId) {
  if (
    typeof runId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)
  ) {
    throw new Error(`invalid run id: ${String(runId)}`);
  }
  return runId;
}

export function parseUnblockRunId(argv = [], env = process.env) {
  const values = argv
    .filter((arg) => arg.startsWith("--unblock-run="))
    .map((arg) => arg.slice("--unblock-run=".length).trim());
  if (values.length > 1) throw new Error("--unblock-run may only be provided once");

  const fromArg = values[0] || null;
  const fromEnv = env.JUNO_UNBLOCK_RUN_ID?.trim() || null;
  if (fromArg && fromEnv && fromArg !== fromEnv) {
    throw new Error("--unblock-run conflicts with JUNO_UNBLOCK_RUN_ID");
  }
  const runId = fromArg ?? fromEnv;
  return runId === null ? null : validateRunId(runId);
}

export function validateRunState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("run-state must be a JSON object");
  }
  const state = value;
  if (!Number.isSafeInteger(state.retryCount) || state.retryCount < 0) {
    throw new Error("run-state retryCount must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(state.slotIndex) || state.slotIndex < 0) {
    throw new Error("run-state slotIndex must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(state.maxRetries) ||
    state.maxRetries < 0 ||
    state.maxRetries > MAX_RUN_MAX_RETRIES
  ) {
    throw new Error(
      `run-state maxRetries must be an integer between 0 and ${MAX_RUN_MAX_RETRIES}`,
    );
  }
  if (state.retryCount > state.maxRetries) {
    throw new Error("run-state retryCount cannot exceed maxRetries");
  }
  if (state.lastStatus !== undefined && typeof state.lastStatus !== "string") {
    throw new Error("run-state lastStatus must be a string when present");
  }
  if (state.updatedAt !== undefined && typeof state.updatedAt !== "string") {
    throw new Error("run-state updatedAt must be a string when present");
  }
  return state;
}

export function inspectRunState(runDir) {
  const statePath = path.join(runDir, "run-state.json");
  if (!existsSync(statePath)) return { kind: "missing" };
  try {
    const state = validateRunState(JSON.parse(readFileSync(statePath, "utf8")));
    return { kind: "valid", state };
  } catch (error) {
    return {
      kind: "invalid",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function decideRunStartup(
  runId,
  inspection,
  unblockRunId,
  now = new Date().toISOString(),
  orchestratorBlocked = false,
) {
  if (unblockRunId && unblockRunId !== runId) {
    return {
      action: "block",
      reason: `unblock request targets ${unblockRunId}, but queue head is ${runId}`,
    };
  }

  if (orchestratorBlocked) {
    if (!unblockRunId) {
      return { action: "block", reason: `run ${runId} is terminally blocked` };
    }
    const prior =
      inspection.kind === "valid"
        ? inspection.state
        : { retryCount: 0, slotIndex: 0, maxRetries: DEFAULT_RUN_MAX_RETRIES };
    return {
      action: "reset",
      state: {
        ...prior,
        retryCount: 0,
        lastStatus: "unblocked",
        updatedAt: now,
      },
    };
  }

  if (inspection.kind === "missing") {
    return unblockRunId
      ? { action: "block", reason: `run ${runId} has no blocked state to unblock` }
      : { action: "continue" };
  }

  if (inspection.kind === "invalid") {
    if (!unblockRunId) {
      return { action: "block", reason: `invalid run-state: ${inspection.reason}` };
    }
    return {
      action: "reset",
      state: {
        retryCount: 0,
        slotIndex: 0,
        maxRetries: DEFAULT_RUN_MAX_RETRIES,
        lastStatus: "unblocked",
        updatedAt: now,
      },
    };
  }

  if (inspection.state.lastStatus === "blocked") {
    if (!unblockRunId) {
      return { action: "block", reason: `run ${runId} is terminally blocked` };
    }
    return {
      action: "reset",
      state: {
        ...inspection.state,
        retryCount: 0,
        lastStatus: "unblocked",
        updatedAt: now,
      },
    };
  }

  if (unblockRunId) {
    return { action: "block", reason: `run ${runId} is not blocked` };
  }
  return { action: "continue" };
}

export function advanceRetryState(state, now = new Date().toISOString()) {
  validateRunState(state);
  if (state.retryCount >= state.maxRetries) {
    return {
      blocked: true,
      state: { ...state, lastStatus: "blocked", updatedAt: now },
    };
  }
  return {
    blocked: false,
    state: {
      ...state,
      retryCount: state.retryCount + 1,
      lastStatus: "failed",
      updatedAt: now,
    },
  };
}

export function normalizeMissionChildResult(result, label = "subprocess") {
  try {
    if (result?.timedOut) throw new Error(`${label} timed out`);
    if (result?.signal) throw new Error(`${label} terminated by ${result.signal}`);
    return { exitCode: checkedSpawnStatus(result, label), error: null };
  } catch (error) {
    return {
      exitCode: 1,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function missionLiveTimeoutMs(maxMinutes) {
  if (
    !Number.isSafeInteger(maxMinutes) ||
    maxMinutes < 1 ||
    maxMinutes > MAX_MANIFEST_RUN_MINUTES
  ) {
    throw new Error(
      `manifest maxMinutes must be an integer between 1 and ${MAX_MANIFEST_RUN_MINUTES}`,
    );
  }
  return Math.min(
    maxMinutes * 60_000 + LIVE_SLOT_TIMEOUT_GRACE_MS,
    MAX_MISSION_LIVE_TIMEOUT_MS,
  );
}

export function verifyTerminationWasUnconfirmed(runDir) {
  const artifactPath = path.join(runDir, "verify-artifact.json");
  if (!existsSync(artifactPath)) return false;
  try {
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    return (
      artifact?.terminationConfirmed === false ||
      (Array.isArray(artifact?.steps) &&
        artifact.steps.some((step) => step?.terminationConfirmed === false))
    );
  } catch {
    return true;
  }
}

function safeRunDir(workbench, runId) {
  try {
    validateRunId(runId);
  } catch {
    return null;
  }
  const runsRoot = path.resolve(workbench, "runs");
  const candidate = path.resolve(runsRoot, runId);
  const relative = path.relative(runsRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return candidate;
}

export async function runMissionLoop(argv = process.argv.slice(2)) {
  const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
  const unblockRunId = parseUnblockRunId(argv);
  const shutdownController = new AbortController();
  let stopSignal = null;
  const requestStop = (signal) => {
    if (stopSignal) return;
    stopSignal = signal;
    log(`${signal} - stopping active child tree`);
    shutdownController.abort();
  };
  process.once("SIGINT", () => requestStop("SIGINT"));
  process.once("SIGTERM", () => requestStop("SIGTERM"));

  process.env.AGENT_WORKBENCH_ROOT = workbench;
  process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

  const skipBuild =
    argv.includes("--skip-build") || process.env.JUNO_SKIP_ORCHESTRATOR_BUILD === "1";
  if (!skipBuild) {
    const build = await spawnPnpmWithTimeout(
      ["orchestrator:build"],
      {
        cwd: repoRoot,
        stdio: "inherit",
        signal: shutdownController.signal,
      },
      BUILD_TIMEOUT_MS,
    );
    if (stopSignal) process.exit(stopSignal === "SIGINT" ? 130 : 143);
    const buildOutcome = normalizeMissionChildResult(build, "orchestrator build");
    if (buildOutcome.exitCode !== 0) {
      log(buildOutcome.error ?? `orchestrator build exited ${buildOutcome.exitCode}`);
      process.exit(buildOutcome.exitCode);
    }
  }

  const { loadProjectEnv } = await import("../orchestrator/dist/env.js");
  loadProjectEnv();

  const { readNowQueueSnapshot, replaceQueueHeadConditional } = await import(
    "../orchestrator/dist/queue-io.js"
  );
  const { materializeQueueRun, saveRunState } = await import(
    "../orchestrator/dist/manifest.js"
  );
  const {
    evaluateCompletedRun,
    markMissionPhaseDone,
    readRunKind,
    shouldMarkPhaseDone,
    buildReviseImplementItem,
    nextRevisionAttempt,
    checkpointTextForAdvance,
    finalizeRunCheckpoint,
  } = await import("../orchestrator/dist/mission-progress.js");
  const { mergeOrchestratorState, readOrchestratorState } = await import(
    "../orchestrator/dist/idempotency.js"
  );
  const { finalizeOrdinaryVerifyQueueHead, recoverPendingVerifyCompletions } = await import(
    "../orchestrator/dist/mission-completion.js"
  );
  const { readWorkflowExperimentRevisionPromptBinding } = await import(
    "../orchestrator/dist/workflow-experiment.js"
  );
  const { acquireRunLauncherLease, releaseRunLauncherLease } = await import(
    "../orchestrator/dist/run-slot-lock.js"
  );

  let completionRecovery;
  try {
    completionRecovery = recoverPendingVerifyCompletions(workbench);
  } catch (error) {
    mergeOrchestratorState(workbench, { activeRunStatus: "blocked" });
    log(`terminal block: invalid completion recovery state: ${error.message}`);
    process.exit(5);
  }
  if (completionRecovery.status === "busy") {
    log("completion recovery busy; no queue state changed");
    process.exit(4);
  }
  if (completionRecovery.status === "blocked") {
    mergeOrchestratorState(workbench, { activeRunStatus: "blocked" });
    log(`terminal block: ${completionRecovery.reason ?? "completion recovery conflict"}`);
    process.exit(5);
  }
  if (completionRecovery.status === "recovered") {
    mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });
    log(
      `recovered completion ${completionRecovery.recovered
        .map((entry) => entry.terminalRunId)
        .join(",")}`,
    );
    process.exit(0);
  }

  let queueSnapshot = readNowQueueSnapshot(workbench);
  let { now } = queueSnapshot;
  if (now.length === 0) {
    log("queue empty - nothing to advance");
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
      queueSnapshot = readNowQueueSnapshot(workbench);
      ({ now } = queueSnapshot);
      if (now.length === 0) {
        log("queue empty after repair");
        process.exit(4);
      }
      head = now[0];
    }
  }
  log(`queue head ${head.id} (${head.phase_id}) mission=${head.mission_id}`);

  const runDir = safeRunDir(workbench, head.id);
  if (!runDir) {
    mergeOrchestratorState(workbench, {
      activeRunId: head.id,
      activeRunStatus: "blocked",
    });
    log(`invalid queue-head run id: ${head.id}`);
    process.exit(5);
  }

  let launcherLease = acquireRunLauncherLease(workbench, head.id);
  if (!launcherLease) {
    log(`launcher busy for ${head.id}; no manifest or retry state changed`);
    process.exit(4);
  }
  const releaseLauncher = () => {
    if (!launcherLease) return true;
    const owned = launcherLease;
    launcherLease = null;
    try {
      const released = releaseRunLauncherLease(owned);
      if (!released) log(`lost launcher lease ownership: ${owned.lockPath}`);
      return released;
    } catch (error) {
      log(
        `launcher lease cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };
  process.once("exit", releaseLauncher);

  try {
  if (runDir) {
    const orchestratorState = readOrchestratorState(workbench);
    const orchestratorBlocked =
      orchestratorState.activeRunId === head.id &&
      String(orchestratorState.activeRunStatus ?? "").toLowerCase() === "blocked";
    const startup = decideRunStartup(
      head.id,
      inspectRunState(runDir),
      unblockRunId,
      new Date().toISOString(),
      orchestratorBlocked,
    );
    if (startup.action === "block") {
      mergeOrchestratorState(workbench, {
        activeRunId: head.id,
        activeRunStatus: "blocked",
      });
      log(`${startup.reason}; explicit recovery: --unblock-run=${head.id}`);
      process.exit(5);
    }
    if (startup.action === "reset") {
      try {
        saveRunState(runDir, startup.state);
      } catch (error) {
        mergeOrchestratorState(workbench, {
          activeRunId: head.id,
          activeRunStatus: "blocked",
        });
        log(
          `failed to persist unblock state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exit(5);
      }
      mergeOrchestratorState(workbench, {
        activeRunId: null,
        activeRunStatus: "idle",
      });
      log(`human unblock accepted for ${head.id}; retry budget reset`);
    }
  }

  let manifestPath;
  let liveSlotDeadlineMs;
  try {
    manifestPath = materializeQueueRun(head);
    const materializedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    liveSlotDeadlineMs = missionLiveTimeoutMs(materializedManifest.maxMinutes);
  } catch (error) {
    if (runDir) {
      const inspected = inspectRunState(runDir);
      const state =
        inspected.kind === "valid"
          ? inspected.state
          : { retryCount: 0, slotIndex: 0, maxRetries: DEFAULT_RUN_MAX_RETRIES };
      try {
        saveRunState(runDir, {
          ...state,
          lastStatus: "blocked",
          updatedAt: new Date().toISOString(),
        });
      } catch {
        /* The orchestrator state below remains the fail-closed authority. */
      }
    }
    mergeOrchestratorState(workbench, {
      activeRunId: head.id,
      activeRunStatus: "blocked",
    });
    log(`materialize blocked: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(5);
  }

  if (!runDir) {
    mergeOrchestratorState(workbench, {
      activeRunId: head.id,
      activeRunStatus: "blocked",
    });
    log(`materialize returned for invalid queue-head run id: ${head.id}`);
    process.exit(5);
  }

  const materializedState = inspectRunState(runDir);
  if (materializedState.kind !== "valid") {
    mergeOrchestratorState(workbench, {
      activeRunId: head.id,
      activeRunStatus: "blocked",
    });
    log(
      `materialized run-state invalid: ${
        materializedState.kind === "invalid" ? materializedState.reason : "missing"
      }`,
    );
    process.exit(5);
  }

  function retryOrBlock(reason) {
    const inspected = inspectRunState(runDir);
    if (inspected.kind !== "valid") {
      mergeOrchestratorState(workbench, {
        activeRunId: head.id,
        activeRunStatus: "blocked",
      });
      log(
        `terminal block: invalid run-state after slot (${inspected.kind === "invalid" ? inspected.reason : "missing"})`,
      );
      process.exit(5);
    }

    const next = advanceRetryState(inspected.state);
    if (next.blocked) {
      mergeOrchestratorState(workbench, {
        activeRunId: head.id,
        activeRunStatus: "blocked",
      });
    }
    try {
      saveRunState(runDir, next.state);
    } catch (error) {
      mergeOrchestratorState(workbench, {
        activeRunId: head.id,
        activeRunStatus: "blocked",
      });
      log(
        `terminal block: failed to persist retry state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(5);
    }
    if (next.blocked) {
      log(
        `terminal block after ${next.state.retryCount}/${next.state.maxRetries} retries: ${reason}`,
      );
      process.exit(5);
    }

    mergeOrchestratorState(workbench, {
      activeRunId: head.id,
      activeRunStatus: "failed",
    });
    log(`retry ${next.state.retryCount}/${next.state.maxRetries}: ${reason}`);
    process.exit(3);
  }

  function terminalBlockWithoutRetry(reason) {
    const inspected = inspectRunState(runDir);
    if (inspected.kind === "valid") {
      try {
        saveRunState(runDir, {
          ...inspected.state,
          lastStatus: "blocked",
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        log(
          `terminal block state persistence failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    mergeOrchestratorState(workbench, {
      activeRunId: head.id,
      activeRunStatus: "blocked",
    });
    log(`terminal block without retry: ${reason}`);
    process.exit(5);
  }

  const spawnScript = path.join(repoRoot, "orchestrator", "dist", "spawn-run.js");
  log(`live spawn ${head.id}`);
  const result = await spawnWithTimeout(
    process.execPath,
    [spawnScript, "--manifest", manifestPath],
    {
      cwd: repoRoot,
      env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench, JUNO_OVERSIGHT_ROOT: repoRoot },
      stdio: "inherit",
      signal: shutdownController.signal,
    },
    liveSlotDeadlineMs,
  );
  if (stopSignal) process.exit(stopSignal === "SIGINT" ? 130 : 143);
  const spawnOutcome = normalizeMissionChildResult(result, "spawn-run");

  if (result.terminationConfirmed === false || verifyTerminationWasUnconfirmed(runDir)) {
    terminalBlockWithoutRetry("verify subprocess tree termination was not confirmed");
  }

  if (isMissionNoProgressExit(spawnOutcome.exitCode)) {
    log(`spawn-run busy for ${head.id}; no retry consumed`);
    process.exit(4);
  }
  if (spawnOutcome.exitCode !== 0) {
    retryOrBlock(
      `spawn-run exit ${spawnOutcome.exitCode}${spawnOutcome.error ? `: ${spawnOutcome.error}` : ""}`,
    );
  }

  const checkpointPath = path.join(runDir, "checkpoint.md");
  if (!existsSync(checkpointPath)) {
    retryOrBlock("no checkpoint.md after live slot");
  }

  const runKind = readRunKind(workbench, head.id);
  if (finalizeRunCheckpoint(workbench, head.id, head.mission_id, runKind)) {
    log(`mirrored mission checkpoint -> runs/${head.id}/checkpoint.md`);
  }

  const checkpoint = checkpointTextForAdvance(workbench, head.id, head.mission_id);
  const action = evaluateCompletedRun(workbench, head.id, head.mission_id);

  if (action.action === "revise") {
    let revisionAttempt;
    try {
      revisionAttempt = nextRevisionAttempt(
        workbench,
        head.id,
        [...queueSnapshot.now, ...queueSnapshot.backlog],
      );
    } catch (error) {
      terminalBlockWithoutRetry(
        `invalid revision lineage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let fix;
    try {
      const experimentPromptBinding = head.experiment_id
        ? readWorkflowExperimentRevisionPromptBinding(workbench, head)
        : undefined;
      fix = buildReviseImplementItem(
        head,
        revisionAttempt,
        action.mustFix ?? [],
        experimentPromptBinding,
      );
    } catch (error) {
      terminalBlockWithoutRetry(
        `invalid revision prompt binding: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const queueUpdate = replaceQueueHeadConditional(workbench, {
      expectedRevision: queueSnapshot.revision,
      expectedHead: head,
      replacement: [fix],
    });
    if (!queueUpdate.ok) {
      if (queueUpdate.reason === "busy") {
        log(`queue mutation busy after ${head.id}; no queue state changed`);
        process.exit(4);
      }
      mergeOrchestratorState(workbench, {
        activeRunId: head.id,
        activeRunStatus: "blocked",
      });
      log(`terminal block: queue ${queueUpdate.reason} after ${head.id}`);
      process.exit(5);
    }
    mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });
    log(`REVISE fix queued for ${head.phase_id}`);
    process.exit(0);
  }

  if (action.action === "block") {
    const inspected = inspectRunState(runDir);
    const state =
      inspected.kind === "valid"
        ? inspected.state
        : { retryCount: 0, slotIndex: 0, maxRetries: DEFAULT_RUN_MAX_RETRIES };
    mergeOrchestratorState(workbench, { activeRunId: head.id, activeRunStatus: "blocked" });
    try {
      saveRunState(runDir, {
        ...state,
        lastStatus: "blocked",
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      log(
        `terminal block state persistence failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    log("terminal block: deterministic gate rejected the slot");
    process.exit(5);
  }

  if (action.action === "hold") {
    retryOrBlock(`gate hold: ${action.reason}`);
  }

  const terminalOrdinaryVerify =
    runKind === "verify" &&
    Boolean(head.mission_id) &&
    ![...queueSnapshot.now.slice(1), ...queueSnapshot.backlog].some(
      (item) => item.mission_id === head.mission_id,
    );
  let queueUpdate;
  try {
    queueUpdate = terminalOrdinaryVerify
      ? finalizeOrdinaryVerifyQueueHead(workbench, {
          expectedQueueRevision: queueSnapshot.revision,
          expectedHead: head,
        })
      : replaceQueueHeadConditional(workbench, {
          expectedRevision: queueSnapshot.revision,
          expectedHead: head,
          replacement: [],
        });
  } catch (error) {
    terminalBlockWithoutRetry(
      `completion preparation rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!queueUpdate.ok) {
    if (queueUpdate.reason === "busy") {
      log(`queue mutation busy after ${head.id}; no queue state changed`);
      process.exit(4);
    }
    mergeOrchestratorState(workbench, {
      activeRunId: head.id,
      activeRunStatus: "blocked",
    });
    log(`terminal block: queue ${queueUpdate.reason} after ${head.id}`);
    process.exit(5);
  }
  if (head.mission_id && head.phase_id && shouldMarkPhaseDone(runKind, checkpoint)) {
    markMissionPhaseDone(workbench, head.mission_id, head.phase_id);
  }

  if (terminalOrdinaryVerify) log(`signed mission completion receipt for ${head.mission_id}`);
  mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });
  log(`done ${head.id}`);
  } finally {
    process.removeListener("exit", releaseLauncher);
    if (!releaseLauncher()) process.exitCode ||= 1;
  }
}

function isMainModule() {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath));
}

if (isMainModule()) {
  try {
    await runMissionLoop();
  } catch (error) {
    process.stderr.write(
      `[mission-loop] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
