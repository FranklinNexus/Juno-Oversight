#!/usr/bin/env node
/**
 * Juno master daemon - bounded autonomy tick in a loop (Juno moves itself).
 *
 * Usage: pnpm juno:daemon [--interval-ms=120000] [--max-consecutive-failures=3]
 *   Recovery: pnpm juno:daemon -- --unblock-daemon [--unblock-run=<run-id>]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireDaemonLifecycleLock,
  canonicalDaemonRoots,
  createDaemonIdentity,
  daemonControlPaths,
  inspectDaemonV2Control,
  MAX_DAEMON_LEASE_BYTES,
  MAX_DAEMON_PID_BYTES,
  MAX_DAEMON_STATE_BYTES,
  parseDaemonControlJson,
  parseLegacyPidSnapshot,
  publishDaemonControlJson,
  publishDaemonControlText,
  readOptionalDaemonControlText,
  releaseDaemonLifecycleLock,
  removeDaemonControlSnapshot,
  validateDaemonIdentity,
  withDaemonLifecycleLock,
} from "./lib/daemon-control.mjs";
import {
  spawnPnpmWithTimeout,
  validatePackagedRuntime,
} from "./lib/pnpm-runner.mjs";
import {
  BUILD_TIMEOUT_MS,
  checkedSpawnStatus,
  spawnWithTimeout,
} from "./lib/specialized-loop-guard.mjs";
import { AUTONOMY_TICK_PARENT_TIMEOUT_MS } from "./juno-autonomy-tick.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

export const DEFAULT_DAEMON_INTERVAL_MS = 120_000;
export const MIN_DAEMON_INTERVAL_MS = 1_000;
export const MAX_DAEMON_INTERVAL_MS = 24 * 60 * 60_000;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
export const MAX_CONSECUTIVE_FAILURES = 100;
const DAEMON_STATUSES = new Set([
  "running",
  "degraded",
  "waiting_midnight",
  "stopped",
  "blocked",
]);

function log(message) {
  process.stderr.write(`[juno-daemon] ${message}\n`);
}

function parseSingleIntegerFlag(argv, name, defaultValue, min, max) {
  const prefix = `--${name}=`;
  const values = argv.filter((arg) => arg.startsWith(prefix));
  if (values.length > 1) throw new Error(`--${name} may only be provided once`);
  if (values.length === 0) return defaultValue;
  const raw = values[0].slice(prefix.length);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function validateRunId(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error(`invalid --unblock-run id: ${runId}`);
  }
  return runId;
}

export function parseDaemonArgs(argv = []) {
  const intervalMs = parseSingleIntegerFlag(
    argv,
    "interval-ms",
    DEFAULT_DAEMON_INTERVAL_MS,
    MIN_DAEMON_INTERVAL_MS,
    MAX_DAEMON_INTERVAL_MS,
  );
  const maxConsecutiveFailures = parseSingleIntegerFlag(
    argv,
    "max-consecutive-failures",
    DEFAULT_MAX_CONSECUTIVE_FAILURES,
    1,
    MAX_CONSECUTIVE_FAILURES,
  );
  const unblockValues = argv
    .filter((arg) => arg.startsWith("--unblock-run="))
    .map((arg) => arg.slice("--unblock-run=".length).trim());
  if (unblockValues.length > 1) throw new Error("--unblock-run may only be provided once");
  const unblockRunId = unblockValues[0] ? validateRunId(unblockValues[0]) : null;
  return {
    intervalMs,
    maxConsecutiveFailures,
    unblockDaemon: argv.includes("--unblock-daemon"),
    unblockRunId,
  };
}

export function normalizeSpawnExit(status) {
  return typeof status === "number" && Number.isInteger(status) ? status : 1;
}

export function normalizeRuntimeChildResult(result, label = "subprocess") {
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

function abortableDelay(ms, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(true), ms);
    const onAbort = () => finish(false);
    function finish(completed) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function advanceDaemonFailureBudget(current, tickExit, maxFailures) {
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error("consecutive failure count must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maxFailures) || maxFailures < 1) {
    throw new Error("max failure count must be a positive safe integer");
  }
  const expectedExit = tickExit === 0 || tickExit === 3 || tickExit === 4;
  const consecutiveFailures = expectedExit ? 0 : current + 1;
  return {
    consecutiveFailures,
    exhausted: !expectedExit && consecutiveFailures >= maxFailures,
  };
}

export function validateDaemonState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("daemon state must be a JSON object");
  }
  if (typeof value.status !== "string" || !DAEMON_STATUSES.has(value.status)) {
    throw new Error("daemon state status is invalid");
  }
  if (!Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0) {
    throw new Error("daemon state consecutiveFailures must be a non-negative safe integer");
  }
  if (value.blockedRunId !== undefined && value.blockedRunId !== null) {
    if (typeof value.blockedRunId !== "string") {
      throw new Error("daemon state blockedRunId must be a string or null");
    }
    validateRunId(value.blockedRunId);
  }
  if (value.protocolVersion !== undefined) validateDaemonIdentity(value, "Daemon state");
  return value;
}

export function writeDaemonStateAtomic(statePath, state, expectedSnapshot = undefined) {
  validateDaemonState(state);
  const expected = expectedSnapshot === undefined
    ? readOptionalDaemonControlText(statePath, "Daemon state", MAX_DAEMON_STATE_BYTES)
    : expectedSnapshot;
  return publishDaemonControlJson(
    statePath,
    state,
    "Daemon state",
    MAX_DAEMON_STATE_BYTES,
    expected,
  );
}

export function inspectDaemonState(statePath) {
  let snapshot = null;
  try {
    snapshot = readOptionalDaemonControlText(
      statePath,
      "Daemon state",
      MAX_DAEMON_STATE_BYTES,
    );
    if (!snapshot) return { kind: "missing", snapshot: null };
    return {
      kind: "valid",
      state: validateDaemonState(parseDaemonControlJson(snapshot, "Daemon state")),
      snapshot,
    };
  } catch (error) {
    return {
      kind: "invalid",
      reason: error instanceof Error ? error.message : String(error),
      snapshot,
    };
  }
}

export function decideDaemonStartup(inspection, config) {
  const explicitlyUnblocked = config.unblockDaemon || Boolean(config.unblockRunId);
  if (inspection.kind === "invalid") {
    return explicitlyUnblocked
      ? { action: "continue", carriedFailures: 0 }
      : { action: "block", reason: `invalid daemon state: ${inspection.reason}` };
  }
  if (inspection.kind === "missing") {
    return { action: "continue", carriedFailures: 0 };
  }

  const prior = inspection.state;
  if (
    config.unblockRunId &&
    prior.blockedRunId &&
    config.unblockRunId !== prior.blockedRunId
  ) {
    return {
      action: "block",
      reason: `unblock request targets ${config.unblockRunId}, but blocked run is ${prior.blockedRunId}`,
    };
  }
  if (prior.status === "blocked" && !explicitlyUnblocked) {
    return {
      action: "block",
      reason: prior.blockedReason ?? "daemon is terminally blocked",
      blockedRunId: prior.blockedRunId ?? null,
    };
  }

  const carriedFailures = !explicitlyUnblocked ? (prior.consecutiveFailures ?? 0) : 0;
  if (carriedFailures >= config.maxConsecutiveFailures) {
    return {
      action: "block",
      reason: `persisted failure budget exhausted (${carriedFailures}/${config.maxConsecutiveFailures})`,
    };
  }
  return { action: "continue", carriedFailures };
}

export function initialDaemonState(
  now,
  carriedFailures = 0,
  explicitlyUnblocked = false,
  identity = null,
) {
  return {
    ...(identity ?? {}),
    status: "running",
    startedAt: now,
    heartbeatAt: now,
    waitUntil: null,
    waitRemainingMs: null,
    lastCapDetail: null,
    blockedReason: null,
    blockedRunId: null,
    lastError: null,
    lastExit: null,
    consecutiveFailures: carriedFailures,
    unblockedAt: explicitlyUnblocked ? now : null,
    updatedAt: now,
  };
}

function blockedRunIdFromOrchestrator(workbench) {
  try {
    const snapshot = readOptionalDaemonControlText(
      path.join(workbench, "state", "orchestrator.json"),
      "Orchestrator state",
      MAX_DAEMON_STATE_BYTES,
    );
    if (!snapshot) return null;
    const state = parseDaemonControlJson(snapshot, "Orchestrator state");
    return typeof state.activeRunId === "string" ? validateRunId(state.activeRunId) : null;
  } catch {
    return null;
  }
}

export async function runJunoDaemon(argv = process.argv.slice(2)) {
  const config = parseDaemonArgs(argv);
  const configuredWorkbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
  const { workbenchRoot: workbench, stateDir } = canonicalDaemonRoots(
    configuredWorkbench,
    true,
  );
  const controlPaths = daemonControlPaths(stateDir);
  const daemonStatePath = controlPaths.state;

  let startupLock = acquireDaemonLifecycleLock(stateDir, "node-startup-preflight");
  let startup;
  try {
    startup = decideDaemonStartup(inspectDaemonState(daemonStatePath), config);
  } finally {
    releaseDaemonLifecycleLock(startupLock);
  }
  if (startup.action === "block") {
    const unblockCommand = startup.blockedRunId
      ? `--unblock-daemon --unblock-run=${startup.blockedRunId}`
      : "--unblock-daemon";
    log(`blocked across restart: ${startup.reason}`);
    log(`explicit recovery required: pnpm juno:daemon -- ${unblockCommand}`);
    process.exitCode = 5;
    return;
  }

  process.env.AGENT_WORKBENCH_ROOT = workbench;
  process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

  const shutdownController = new AbortController();
  let stopSignal = null;
  const requestStop = (signal) => {
    if (stopSignal) return;
    stopSignal = signal;
    log(`${signal} - stopping active child tree`);
    shutdownController.abort();
  };
  const onSigint = () => requestStop("SIGINT");
  const onSigterm = () => requestStop("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  let cleanup = () => {};
  try {
    if (process.env.JUNO_PACKAGED_RUNTIME === "1") {
      validatePackagedRuntime(repoRoot);
      process.env.JUNO_SKIP_ORCHESTRATOR_BUILD = "1";
      log("using integrity-verified packaged orchestrator (runtime rebuilds disabled)");
    } else {
      const buildOnce = await spawnPnpmWithTimeout(
        ["orchestrator:build"],
        {
          cwd: repoRoot,
          stdio: "inherit",
          signal: shutdownController.signal,
        },
        BUILD_TIMEOUT_MS,
      );
      if (stopSignal) {
        process.exitCode = 0;
        return;
      }
      const buildOutcome = normalizeRuntimeChildResult(buildOnce, "orchestrator build");
      if (buildOutcome.exitCode !== 0) {
        log(buildOutcome.error ?? `orchestrator build exited ${buildOutcome.exitCode}`);
        process.exitCode = buildOutcome.exitCode;
        return;
      }
    }

    const { acquireAutonomyLock, releaseAutonomyLock, readAutonomyLock } = await import(
      "../orchestrator/dist/autonomy-lock.js"
    );
    const { msUntilNextAutonomyDay } = await import("../orchestrator/dist/autonomy-day.js");
    let autonomyOwned = false;
    let daemonState = null;
    let daemonStateSnapshot = null;
    let leaseSnapshot = null;
    let pidSnapshot = null;
    let identity = null;

    startupLock = acquireDaemonLifecycleLock(stateDir, "node-startup-publish");
    try {
      const lockedInspection = inspectDaemonState(daemonStatePath);
      startup = decideDaemonStartup(lockedInspection, config);
      if (startup.action === "block") {
        const unblockCommand = startup.blockedRunId
          ? `--unblock-daemon --unblock-run=${startup.blockedRunId}`
          : "--unblock-daemon";
        log(`blocked across restart: ${startup.reason}`);
        log(`explicit recovery required: pnpm juno:daemon -- ${unblockCommand}`);
        process.exitCode = 5;
        return;
      }

      let existingControl;
      if (lockedInspection.kind === "invalid") {
        const foreignLease = readOptionalDaemonControlText(
          controlPaths.lease,
          "Daemon lease",
          MAX_DAEMON_LEASE_BYTES,
        );
        if (foreignLease) {
          throw new Error("Invalid daemon state is paired with a lease; refusing recovery overwrite");
        }
        existingControl = {
          kind: "legacy",
          stateSnapshot: lockedInspection.snapshot ?? null,
          pidSnapshot: readOptionalDaemonControlText(
            controlPaths.pid,
            "Daemon PID",
            MAX_DAEMON_PID_BYTES,
          ),
        };
      } else {
        existingControl = inspectDaemonV2Control(workbench, stateDir);
      }

      if (existingControl.kind === "v2") {
        if (existingControl.live) {
          log(
            `blocked - daemon generation ${existingControl.identity.generation} is already live pid=${existingControl.identity.pid}`,
          );
          process.exitCode = 1;
          return;
        }
        removeDaemonControlSnapshot(
          controlPaths.lease,
          "Daemon lease",
          MAX_DAEMON_LEASE_BYTES,
          existingControl.leaseSnapshot,
        );
        removeDaemonControlSnapshot(
          controlPaths.pid,
          "Daemon PID",
          MAX_DAEMON_PID_BYTES,
          existingControl.pidSnapshot,
        );
      } else if (existingControl.pidSnapshot) {
        const legacyPid = parseLegacyPidSnapshot(existingControl.pidSnapshot);
        try {
          process.kill(legacyPid, 0);
          throw new Error(
            `Live legacy daemon PID ${legacyPid} cannot be safely replaced; stop it through its owning process`,
          );
        } catch (error) {
          if (error instanceof Error && error.message.includes("cannot be safely replaced")) throw error;
        }
        removeDaemonControlSnapshot(
          controlPaths.pid,
          "Daemon legacy PID",
          MAX_DAEMON_PID_BYTES,
          existingControl.pidSnapshot,
        );
      }

      if (!acquireAutonomyLock(workbench, "juno-daemon")) {
        const held = readAutonomyLock(workbench);
        process.stderr.write(
          `[juno-daemon] blocked - autonomy lock held by ${held?.holder ?? "?"} pid=${held?.pid ?? "?"}\n`,
        );
        process.exitCode = 1;
        return;
      }
      autonomyOwned = true;

      const explicitlyUnblocked = config.unblockDaemon || Boolean(config.unblockRunId);
      const startedAt = new Date().toISOString();
      identity = createDaemonIdentity(workbench);
      daemonState = initialDaemonState(
        startedAt,
        startup.carriedFailures,
        explicitlyUnblocked,
        identity,
      );
      try {
        leaseSnapshot = publishDaemonControlJson(
          controlPaths.lease,
          { ...identity, acquiredAt: startedAt },
          "Daemon lease",
          MAX_DAEMON_LEASE_BYTES,
        );
        pidSnapshot = publishDaemonControlText(
          controlPaths.pid,
          `${process.pid}\n`,
          "Daemon legacy PID shadow",
          MAX_DAEMON_PID_BYTES,
        );
        daemonStateSnapshot = writeDaemonStateAtomic(
          daemonStatePath,
          daemonState,
          lockedInspection.snapshot ?? null,
        );
      } catch (error) {
        if (pidSnapshot) {
          try {
            removeDaemonControlSnapshot(
              controlPaths.pid,
              "Daemon legacy PID shadow",
              MAX_DAEMON_PID_BYTES,
              pidSnapshot,
            );
          } catch {
            /* A foreign replacement remains untouched and blocks the next startup. */
          }
        }
        if (leaseSnapshot) {
          try {
            removeDaemonControlSnapshot(
              controlPaths.lease,
              "Daemon lease",
              MAX_DAEMON_LEASE_BYTES,
              leaseSnapshot,
            );
          } catch {
            /* A foreign replacement remains untouched and blocks the next startup. */
          }
        }
        releaseAutonomyLock(workbench, "juno-daemon");
        autonomyOwned = false;
        throw error;
      }
    } finally {
      releaseDaemonLifecycleLock(startupLock);
      delete process.env.JUNO_LIFECYCLE_HANDOFF_TOKEN;
    }

    if (!identity || !daemonState || !leaseSnapshot || !pidSnapshot || !daemonStateSnapshot) {
      return;
    }

    function writeState(patch) {
      if (!daemonState) throw new Error("daemon state is not initialized");
      withDaemonLifecycleLock(stateDir, "node-state-publish", () => {
        daemonState = validateDaemonState({
          ...daemonState,
          ...patch,
          updatedAt: new Date().toISOString(),
        });
        daemonStateSnapshot = writeDaemonStateAtomic(
          daemonStatePath,
          daemonState,
          daemonStateSnapshot,
        );
      });
    }

    let exited = false;
    let finalStatus = "stopped";
    function onExit() {
      if (exited) return;
      exited = true;
      try {
        withDaemonLifecycleLock(stateDir, "node-cleanup", () => {
          try {
            daemonState = validateDaemonState({
              ...daemonState,
              status: finalStatus,
              heartbeatAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            daemonStateSnapshot = writeDaemonStateAtomic(
              daemonStatePath,
              daemonState,
              daemonStateSnapshot,
            );
          } catch {
            /* Control cleanup still uses generation-bound snapshots. */
          }
          try {
            removeDaemonControlSnapshot(
              controlPaths.pid,
              "Daemon legacy PID shadow",
              MAX_DAEMON_PID_BYTES,
              pidSnapshot,
            );
          } catch {
            /* A missing or replaced PID shadow is not ours to remove. */
          }
          try {
            removeDaemonControlSnapshot(
              controlPaths.lease,
              "Daemon lease",
              MAX_DAEMON_LEASE_BYTES,
              leaseSnapshot,
            );
          } catch {
            /* A missing or replaced lease is not ours to remove. */
          }
          if (autonomyOwned) {
            releaseAutonomyLock(workbench, "juno-daemon");
            autonomyOwned = false;
          }
        });
      } catch {
        /* A residual lifecycle/control file is intentionally fail-closed. */
      }
    }
    cleanup = onExit;
    process.on("exit", onExit);
    log(
      `started generation=${identity.generation} pid=${process.pid} interval=${config.intervalMs}ms failure-budget=${config.maxConsecutiveFailures}`,
    );

    let consecutiveFailures = startup.carriedFailures;
    let pendingUnblockRunId = config.unblockRunId;

    try {
      while (!stopSignal) {
      const tickEnv = { ...process.env, JUNO_SKIP_ORCHESTRATOR_BUILD: "1" };
      if (pendingUnblockRunId) tickEnv.JUNO_UNBLOCK_RUN_ID = pendingUnblockRunId;
      else delete tickEnv.JUNO_UNBLOCK_RUN_ID;

      const result = await spawnWithTimeout(
        process.execPath,
        ["scripts/juno-autonomy-tick.mjs", "--execute", "--skip-build"],
        {
          cwd: repoRoot,
          env: tickEnv,
          stdio: "inherit",
          signal: shutdownController.signal,
        },
        AUTONOMY_TICK_PARENT_TIMEOUT_MS,
      );
      pendingUnblockRunId = null;
      if (stopSignal) break;

      const tickOutcome = normalizeRuntimeChildResult(result, "autonomy tick");
      const tickExit = tickOutcome.exitCode;
      let planner = null;
      if (tickExit === 2 || tickExit === 0) {
        try {
          const plannerSnapshot = readOptionalDaemonControlText(
            path.join(workbench, "state", "mission-planner.json"),
            "Mission planner state",
            MAX_DAEMON_STATE_BYTES,
          );
          planner = plannerSnapshot
            ? parseDaemonControlJson(plannerSnapshot, "Mission planner state")
            : null;
        } catch {
          planner = null;
        }
      }
      const plannerReason = planner?.decision?.reason ?? "exit_2";
      const waitingForDailyReset = tickExit === 2 && plannerReason === "daily_iteration_cap";
      const failureBudget = advanceDaemonFailureBudget(
        consecutiveFailures,
        waitingForDailyReset ? 0 : tickExit,
        config.maxConsecutiveFailures,
      );
      consecutiveFailures = failureBudget.consecutiveFailures;
      const lastError =
        tickOutcome.error ?? (result.signal ? `tick terminated by ${result.signal}` : null);
      writeState({
        lastExit: tickExit,
        lastError,
        status: tickExit === 0 ? "running" : "degraded",
        heartbeatAt: new Date().toISOString(),
        consecutiveFailures,
      });

      if (tickExit === 5) {
        const blockedRunId = blockedRunIdFromOrchestrator(workbench);
        finalStatus = "blocked";
        writeState({
          status: "blocked",
          blockedReason: "terminal mission gate",
          blockedRunId,
          heartbeatAt: new Date().toISOString(),
        });
        log("terminal mission gate - daemon stopped for human review");
        log(
          blockedRunId
            ? `explicit recovery: pnpm juno:daemon -- --unblock-daemon --unblock-run=${blockedRunId}`
            : "explicit recovery: pnpm juno:daemon -- --unblock-daemon",
        );
        process.exitCode = 5;
        break;
      }

      if (failureBudget.exhausted) {
        finalStatus = "blocked";
        const blockedReason = `daemon failure budget exhausted (${consecutiveFailures}/${config.maxConsecutiveFailures}), last exit=${tickExit}${lastError ? `: ${lastError}` : ""}`;
        writeState({
          status: "blocked",
          blockedReason,
          blockedRunId: null,
          heartbeatAt: new Date().toISOString(),
        });
        log(blockedReason);
        log("explicit recovery: pnpm juno:daemon -- --unblock-daemon");
        process.exitCode = 5;
        break;
      }

      if (tickExit === 3) {
        log(`gate hold (review/verify pending) - retry in ${config.intervalMs / 1000}s`);
      } else if (tickExit === 2) {
        if (plannerReason === "daily_iteration_cap") {
          try {
            const waitMs = msUntilNextAutonomyDay(workbench);
            const nextAt = new Date(Date.now() + waitMs).toISOString();
            log(
              `daily cap reached (${planner.decision.detail ?? ""}) - sleeping until next autonomy day (~${Math.round(waitMs / 60_000)} min)`,
            );
            writeState({
              status: "waiting_midnight",
              waitUntil: nextAt,
              lastCapDetail: planner?.decision?.detail ?? null,
              consecutiveFailures: 0,
            });
            const chunkMs = 5 * 60_000;
            let remaining = waitMs;
            while (remaining > 0) {
              const slice = Math.min(chunkMs, remaining);
              if (!(await abortableDelay(slice, shutdownController.signal))) break;
              remaining -= slice;
              writeState({
                status: "waiting_midnight",
                waitUntil: nextAt,
                heartbeatAt: new Date().toISOString(),
                waitRemainingMs: remaining,
              });
            }
            if (stopSignal) break;
            log("autonomy day reset - resume ticks");
            writeState({
              status: "running",
              waitUntil: null,
              waitRemainingMs: null,
              lastCapDetail: null,
            });
            continue;
          } catch (error) {
            throw new Error(
              `failed to wait for autonomy-day reset: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        log(
          `autonomy pause (${plannerReason}) - failure ${consecutiveFailures}/${config.maxConsecutiveFailures}, retry in ${config.intervalMs / 1000}s`,
        );
      }

      if (tickExit === 4) {
        log("idle (empty queue) - retry after interval");
      }

      if (tickExit === 0) {
        if (planner?.decision?.action === "stop") {
          log(`idle: ${planner.decision.reason}`);
        }
      }

        if (!(await abortableDelay(config.intervalMs, shutdownController.signal))) break;
      }
    } catch (error) {
      finalStatus = "blocked";
      const blockedReason = `fatal daemon error: ${
        error instanceof Error ? error.message : String(error)
      }`;
      try {
        writeState({
          status: "blocked",
          blockedReason,
          blockedRunId: null,
          heartbeatAt: new Date().toISOString(),
        });
      } catch {
        /* onExit still releases the lock and removes the PID file. */
      }
      log(blockedReason);
      process.exitCode = 5;
    }
  } finally {
    cleanup();
    process.removeListener("exit", cleanup);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

function isMainModule() {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath));
}

if (isMainModule()) {
  try {
    await runJunoDaemon();
  } catch (error) {
    process.stderr.write(
      `[juno-daemon] fatal startup error: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
