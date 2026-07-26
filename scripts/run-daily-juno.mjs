#!/usr/bin/env node
/**
 * Daily Juno batch - fill autonomy cap, export to isolated folder, purge ephemeral runs.
 *
 * Usage:
 *   node scripts/run-daily-juno.mjs
 *   node scripts/run-daily-juno.mjs --dry-run
 *   node scripts/run-daily-juno.mjs --max-consecutive-failures=3
 *   node scripts/run-daily-juno.mjs --unblock-daily
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpmWithTimeout } from "./lib/pnpm-runner.mjs";
import {
  BUILD_TIMEOUT_MS,
  checkedSpawnStatus,
  spawnWithTimeout,
} from "./lib/specialized-loop-guard.mjs";
import { AUTONOMY_TICK_PARENT_TIMEOUT_MS } from "./juno-autonomy-tick.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

export const DEFAULT_DAILY_MAX_IDLE_TICKS = 5;
export const DEFAULT_DAILY_MAX_CONSECUTIVE_FAILURES = 3;
export const MIN_DAILY_INTERVAL_MS = 1_000;
export const MAX_DAILY_INTERVAL_MS = 24 * 60 * 60_000;
export const MAX_DAILY_ITERATIONS = 10_000;
export const MAX_DAILY_IDLE_TICKS = 100;

function log(message) {
  process.stderr.write(`[daily-juno] ${message}\n`);
}

function boundedInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function parseDailyArgs(argv = []) {
  const prefix = "--max-consecutive-failures=";
  const values = argv.filter((arg) => arg.startsWith(prefix));
  if (values.length > 1) {
    throw new Error("--max-consecutive-failures may only be provided once");
  }
  const maxConsecutiveFailures = values.length
    ? boundedInteger(
        /^\d+$/.test(values[0].slice(prefix.length))
          ? Number(values[0].slice(prefix.length))
          : Number.NaN,
        "--max-consecutive-failures",
        1,
        100,
      )
    : DEFAULT_DAILY_MAX_CONSECUTIVE_FAILURES;
  const unblockCount = argv.filter((arg) => arg === "--unblock-daily").length;
  if (unblockCount > 1) throw new Error("--unblock-daily may only be provided once");
  return {
    dryRun: argv.includes("--dry-run"),
    maxConsecutiveFailures,
    unblockDaily: unblockCount === 1,
  };
}

export function validateDailySchedule(schedule, defaultMaxIterations) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    throw new Error("daily schedule must be a JSON object");
  }
  if (schedule.enabled !== undefined && typeof schedule.enabled !== "boolean") {
    throw new Error("daily schedule enabled must be boolean");
  }
  if (schedule.purgeAfterRun !== undefined && typeof schedule.purgeAfterRun !== "boolean") {
    throw new Error("daily schedule purgeAfterRun must be boolean");
  }
  if (schedule.exportRoot !== undefined && typeof schedule.exportRoot !== "string") {
    throw new Error("daily schedule exportRoot must be a string");
  }
  if (schedule.startHourLocal !== undefined) {
    boundedInteger(schedule.startHourLocal, "daily schedule startHourLocal", 0, 23);
  }
  if (schedule.exportRetentionDays !== undefined) {
    boundedInteger(
      schedule.exportRetentionDays,
      "daily schedule exportRetentionDays",
      0,
      36_500,
    );
  }

  const intervalMs = boundedInteger(
    schedule.tickIntervalMs,
    "daily schedule tickIntervalMs",
    MIN_DAILY_INTERVAL_MS,
    MAX_DAILY_INTERVAL_MS,
  );
  const maxIterations = boundedInteger(
    schedule.maxIterationsPerDay ?? defaultMaxIterations,
    "daily schedule maxIterationsPerDay",
    1,
    MAX_DAILY_ITERATIONS,
  );
  const maxIdleTicks = boundedInteger(
    schedule.maxIdleTicks ?? DEFAULT_DAILY_MAX_IDLE_TICKS,
    "daily schedule maxIdleTicks",
    1,
    MAX_DAILY_IDLE_TICKS,
  );
  return { ...schedule, intervalMs, maxIterations, maxIdleTicks };
}

export function validateDailyScheduleFile(workbench) {
  const schedulePath = path.join(workbench, "config", "daily-schedule.json");
  if (!existsSync(schedulePath)) return;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(schedulePath, "utf8"));
  } catch (error) {
    throw new Error(
      `daily schedule is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("daily schedule file must contain a JSON object");
  }
}

export function normalizeDailyTickExit(status) {
  return typeof status === "number" && Number.isInteger(status) ? status : 1;
}

export function normalizeDailyChildResult(result, label = "subprocess") {
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

export function advanceDailyBudgets(current, observation, limits) {
  for (const label of ["failureStreak", "noProgressStreak", "idleStreak"]) {
    const value = current[label];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative safe integer`);
    }
  }
  const madeProgress = observation.iterationsAfter > observation.iterationsBefore;
  const failureStreak = observation.tickExit === 0 ? 0 : current.failureStreak + 1;
  const noProgressStreak = madeProgress ? 0 : current.noProgressStreak + 1;
  const idleStreak =
    observation.plannerAction === "stop" ? current.idleStreak + 1 : 0;

  let terminalReason = null;
  if (failureStreak >= limits.maxConsecutiveFailures) {
    terminalReason = "consecutive_tick_failures";
  } else if (idleStreak >= limits.maxIdleTicks) {
    terminalReason = "idle_limit";
  } else if (noProgressStreak >= limits.maxIdleTicks) {
    terminalReason = "no_progress_limit";
  }
  return { failureStreak, noProgressStreak, idleStreak, terminalReason };
}

export function decideDailyFinalOutcome({
  capFilled,
  terminationReason = /** @type {string | null} */ (null),
  exportErrors = 0,
  purgeErrors = 0,
}) {
  if (!capFilled) {
    return {
      status: "blocked",
      exitCode: 5,
      reason: terminationReason ?? "cap_not_filled",
    };
  }
  if (exportErrors > 0) {
    return { status: "failed", exitCode: 1, reason: "export_failed" };
  }
  if (purgeErrors > 0) {
    return { status: "failed", exitCode: 1, reason: "purge_failed" };
  }
  return { status: "complete", exitCode: 0, reason: "daily_iteration_cap" };
}

const DAILY_RUN_STATUSES = new Set([
  "running",
  "interrupted",
  "blocked",
  "failed",
  "complete",
  "disabled",
  "dry-run",
]);

export function inspectDailyRunState(statePath) {
  if (!existsSync(statePath)) return { kind: "missing" };
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("daily state must be a JSON object");
    }
    if (typeof state.autonomyDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(state.autonomyDate)) {
      throw new Error("daily state autonomyDate must be YYYY-MM-DD");
    }
    if (typeof state.status !== "string" || !DAILY_RUN_STATUSES.has(state.status)) {
      throw new Error("daily state status is invalid");
    }
    if (state.dryRun !== undefined && typeof state.dryRun !== "boolean") {
      throw new Error("daily state dryRun must be boolean");
    }
    for (const key of ["failureStreak", "noProgressStreak", "idleStreak"]) {
      if (state[key] !== undefined && (!Number.isSafeInteger(state[key]) || state[key] < 0)) {
        throw new Error(`daily state ${key} must be a non-negative safe integer`);
      }
    }
    return { kind: "valid", state };
  } catch (error) {
    return {
      kind: "invalid",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function decideDailyStartup(inspection, autonomyDate, limits, unblockDaily = false) {
  const emptyBudgets = { failureStreak: 0, noProgressStreak: 0, idleStreak: 0 };
  if (inspection.kind === "missing") return { action: "continue", budgets: emptyBudgets };
  if (inspection.kind === "invalid") {
    return unblockDaily
      ? { action: "continue", budgets: emptyBudgets }
      : { action: "block", reason: `invalid daily state: ${inspection.reason}` };
  }

  const prior = inspection.state;
  if (prior.autonomyDate !== autonomyDate || prior.status === "dry-run" || prior.dryRun === true) {
    return { action: "continue", budgets: emptyBudgets };
  }
  if (unblockDaily) return { action: "continue", budgets: emptyBudgets };
  if (prior.status === "complete") return { action: "already_complete" };
  if (prior.status === "blocked" || prior.status === "failed") {
    return {
      action: "block",
      reason: prior.blockedReason ?? prior.terminationReason ?? `prior_${prior.status}`,
    };
  }

  const budgets = {
    failureStreak: prior.failureStreak ?? 0,
    noProgressStreak: prior.noProgressStreak ?? 0,
    idleStreak: prior.idleStreak ?? 0,
  };
  if (budgets.failureStreak >= limits.maxConsecutiveFailures) {
    return { action: "block", reason: "consecutive_tick_failures" };
  }
  if (budgets.idleStreak >= limits.maxIdleTicks) {
    return { action: "block", reason: "idle_limit" };
  }
  if (budgets.noProgressStreak >= limits.maxIdleTicks) {
    return { action: "block", reason: "no_progress_limit" };
  }
  return { action: "continue", budgets };
}

export async function runDailyJuno(argv = process.argv.slice(2)) {
  const args = parseDailyArgs(argv);
  const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
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
  const removeSignalHandlers = () => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const build = await spawnPnpmWithTimeout(
    ["orchestrator:build"],
    {
      cwd: repoRoot,
      stdio: "inherit",
      signal: shutdownController.signal,
    },
    BUILD_TIMEOUT_MS,
  );
  if (stopSignal) {
    removeSignalHandlers();
    return stopSignal === "SIGINT" ? 130 : 143;
  }
  const buildOutcome = normalizeDailyChildResult(build, "orchestrator build");
  if (buildOutcome.exitCode !== 0) {
    log(buildOutcome.error ?? `orchestrator build exited ${buildOutcome.exitCode}`);
    removeSignalHandlers();
    return buildOutcome.exitCode;
  }

  const { loadProjectEnv } = await import("../orchestrator/dist/env.js");
  loadProjectEnv();
  const { loadDailySchedule } = await import("../orchestrator/dist/daily-schedule.js");
  const { readAutonomyState, DEFAULT_AUTONOMY_LIMITS } = await import(
    "../orchestrator/dist/bounded-autonomy.js"
  );
  const { syncBookQualityMissionComplete } = await import(
    "../orchestrator/dist/self-optimize.js"
  );
  const { runDailyExport, validateExportRoot } = await import(
    "../orchestrator/dist/daily-export.js"
  );
  const { planWorkbenchPurge, executeWorkbenchPurge } = await import(
    "../orchestrator/dist/workbench-purge.js"
  );
  const { acquireAutonomyLock, releaseAutonomyLock, readAutonomyLock } = await import(
    "../orchestrator/dist/autonomy-lock.js"
  );
  const { todayAutonomyDate } = await import("../orchestrator/dist/autonomy-day.js");

  validateDailyScheduleFile(workbench);
  const schedule = validateDailySchedule(
    loadDailySchedule(workbench),
    DEFAULT_AUTONOMY_LIMITS.maxSelfIterationsPerDay,
  );

  const stateDir = path.join(workbench, "state");
  const runStatePath = path.join(stateDir, "daily-juno.json");
  const pidPath = path.join(stateDir, "daily-juno.pid");

  const runReport = {
    startedAt: new Date().toISOString(),
    autonomyDate: todayAutonomyDate(workbench),
    dryRun: args.dryRun,
    schedule: {
      exportRoot: schedule.exportRoot,
      maxIterationsPerDay: schedule.maxIterations,
      maxIdleTicks: schedule.maxIdleTicks,
      maxConsecutiveFailures: args.maxConsecutiveFailures,
      tickIntervalMs: schedule.intervalMs,
      autonomyTimezone: schedule.autonomyTimezone,
    },
    ticks: 0,
    capFilled: false,
    idleStreak: 0,
    noProgressStreak: 0,
    failureStreak: 0,
    terminationReason: null,
    export: null,
    purge: null,
    validation: null,
  };

  function persistReport(status, extra = {}) {
    writeFileSync(
      runStatePath,
      `${JSON.stringify(
        {
          ...runReport,
          ...extra,
          status,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  if (args.dryRun) {
    const vaultConfig = existsSync(path.join(workbench, "config.yaml"))
      ? readFileSync(path.join(workbench, "config.yaml"), "utf8").match(
          /vault_path:\s*["']?([^"'\n]+)/i,
        )?.[1]
      : undefined;
    const exportCheck = validateExportRoot(schedule.exportRoot ?? "E:\\JunoDailyExport", {
      workbenchRoot: workbench,
      repoRoot,
      vaultPath: vaultConfig?.trim().replace(/\\\\/g, "\\"),
    });
    const purgePolicy = {
      runsRetentionDays: 0,
      runsKeepRecent: 3,
      stagingRetentionDays: 0,
      purgeEmptyRuns: true,
      ...schedule.purgePolicy,
    };
    const purgePlan = planWorkbenchPurge(workbench, purgePolicy);
    runReport.validation = {
      exportOk: exportCheck.ok,
      exportReason: exportCheck.ok ? undefined : exportCheck.reason,
      purgeCandidates: purgePlan.candidates.length,
      purgeBytes: purgePlan.totalBytes,
    };
    log(JSON.stringify(runReport.validation, null, 2));
    removeSignalHandlers();
    return exportCheck.ok ? 0 : 1;
  }

  mkdirSync(stateDir, { recursive: true });

  const startup = decideDailyStartup(
    inspectDailyRunState(runStatePath),
    runReport.autonomyDate,
    {
      maxConsecutiveFailures: args.maxConsecutiveFailures,
      maxIdleTicks: schedule.maxIdleTicks,
    },
    args.unblockDaily,
  );
  if (startup.action === "block") {
    log(`blocked across restart: ${startup.reason}`);
    log("explicit recovery required: --unblock-daily");
    removeSignalHandlers();
    return 5;
  }
  if (startup.action === "already_complete") {
    log(`autonomy day ${runReport.autonomyDate} already complete`);
    removeSignalHandlers();
    return 0;
  }
  Object.assign(runReport, startup.budgets);

  if (!acquireAutonomyLock(workbench, "daily-juno")) {
    const held = readAutonomyLock(workbench);
    log(`blocked - autonomy lock held by ${held?.holder ?? "?"} pid=${held?.pid ?? "?"}`);
    removeSignalHandlers();
    return 5;
  }
  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      if (readFileSync(pidPath, "utf8").trim() === String(process.pid)) {
        rmSync(pidPath, { force: true });
      }
    } catch {
      /* A missing or replaced PID file is not ours to remove. */
    }
    releaseAutonomyLock(workbench, "daily-juno");
    removeSignalHandlers();
  }

  process.on("exit", cleanup);

  try {
    writeFileSync(pidPath, String(process.pid), "utf8");
    if (!schedule.enabled) {
      log("daily-schedule.json enabled=false - exit");
      persistReport("disabled", { finishedAt: new Date().toISOString() });
      return 0;
    }
    if (syncBookQualityMissionComplete(workbench)) {
      log("book-quality maintenance scan recorded PASS");
    }

    log(
      `autonomyDate=${runReport.autonomyDate} maxIterations=${schedule.maxIterations} interval=${schedule.intervalMs}ms idle-limit=${schedule.maxIdleTicks} failure-limit=${args.maxConsecutiveFailures}`,
    );

    let budgets = { ...startup.budgets };
    persistReport("running");
    while (!stopSignal) {
      const before = readAutonomyState(workbench);
      if (before.iterationsToday >= schedule.maxIterations) {
        runReport.capFilled = true;
        runReport.terminationReason = "daily_iteration_cap";
        log(`daily cap filled: ${before.iterationsToday}/${schedule.maxIterations}`);
        break;
      }

      const result = await spawnWithTimeout(
        process.execPath,
        ["scripts/juno-autonomy-tick.mjs", "--execute", "--skip-build"],
        {
          cwd: repoRoot,
          env: { ...process.env, JUNO_SKIP_ORCHESTRATOR_BUILD: "1" },
          stdio: "inherit",
          signal: shutdownController.signal,
        },
        AUTONOMY_TICK_PARENT_TIMEOUT_MS,
      );
      if (stopSignal) {
        runReport.terminationReason = stopSignal;
        persistReport("interrupted", { finishedAt: new Date().toISOString() });
        return stopSignal === "SIGINT" ? 130 : 143;
      }
      runReport.ticks += 1;
      const tickOutcome = normalizeDailyChildResult(result, "autonomy tick");
      const tickExit = tickOutcome.exitCode;
      const tickError =
        tickOutcome.error ?? (result.signal ? `tick terminated by ${result.signal}` : null);
      const after = readAutonomyState(workbench);

      let plannerDecision = null;
      try {
        plannerDecision = JSON.parse(
          readFileSync(path.join(workbench, "state", "mission-planner.json"), "utf8"),
        ).decision;
      } catch {
        /* Missing planner evidence is counted as no progress below. */
      }

      if (after.iterationsToday >= schedule.maxIterations) {
        runReport.capFilled = true;
        runReport.terminationReason = "daily_iteration_cap";
        log(`daily cap filled after tick: ${after.iterationsToday}/${schedule.maxIterations}`);
        break;
      }

      budgets = advanceDailyBudgets(
        budgets,
        {
          tickExit,
          iterationsBefore: before.iterationsToday,
          iterationsAfter: after.iterationsToday,
          plannerAction: plannerDecision?.action ?? null,
        },
        {
          maxConsecutiveFailures: args.maxConsecutiveFailures,
          maxIdleTicks: schedule.maxIdleTicks,
        },
      );
      runReport.failureStreak = budgets.failureStreak;
      runReport.noProgressStreak = budgets.noProgressStreak;
      runReport.idleStreak = budgets.idleStreak;
      persistReport("running");

      if (tickExit !== 0) {
        log(
          `tick exit ${tickExit}${tickError ? ` (${tickError})` : ""} - failure ${budgets.failureStreak}/${args.maxConsecutiveFailures}`,
        );
      }
      if (plannerDecision?.action === "stop") {
        log(
          `idle stop ${budgets.idleStreak}/${schedule.maxIdleTicks}: ${plannerDecision.reason ?? "unknown"}`,
        );
      } else if (tickExit === 2) {
        log(
          `autonomy pause (${plannerDecision?.reason ?? "unknown"}) - bounded retry ${budgets.noProgressStreak}/${schedule.maxIdleTicks}`,
        );
      }

      if (budgets.terminalReason) {
        runReport.terminationReason = budgets.terminalReason;
        log(`terminal block: ${budgets.terminalReason}`);
        break;
      }

      if (!(await abortableDelay(schedule.intervalMs, shutdownController.signal))) {
        runReport.terminationReason = stopSignal ?? "interrupted";
        persistReport("interrupted", { finishedAt: new Date().toISOString() });
        return stopSignal === "SIGINT" ? 130 : 143;
      }
    }

    if (stopSignal) {
      runReport.terminationReason = stopSignal;
      persistReport("interrupted", { finishedAt: new Date().toISOString() });
      return stopSignal === "SIGINT" ? 130 : 143;
    }

    const exportResult = runDailyExport(workbench, { repoRoot });
    runReport.export = exportResult;
    log(`export -> ${exportResult.exportDir} (${exportResult.copiedFiles.length} files)`);
    if (exportResult.errors.length) {
      for (const error of exportResult.errors) log(`export error: ${error}`);
    }

    const prePurgeOutcome = decideDailyFinalOutcome({
      capFilled: runReport.capFilled,
      terminationReason: runReport.terminationReason,
      exportErrors: exportResult.errors.length,
    });
    if (prePurgeOutcome.status === "blocked") {
      persistReport(prePurgeOutcome.status, {
        finishedAt: new Date().toISOString(),
        blockedReason: prePurgeOutcome.reason,
      });
      return prePurgeOutcome.exitCode;
    }
    if (prePurgeOutcome.status === "failed") {
      runReport.terminationReason = prePurgeOutcome.reason;
      persistReport(prePurgeOutcome.status, { finishedAt: new Date().toISOString() });
      return prePurgeOutcome.exitCode;
    }

    let purgeErrors = 0;
    if (schedule.purgeAfterRun !== false) {
      const policy = {
        runsRetentionDays: 0,
        runsKeepRecent: 3,
        stagingRetentionDays: 0,
        purgeEmptyRuns: true,
        ...schedule.purgePolicy,
      };
      const plan = planWorkbenchPurge(workbench, policy);
      const purgeResult = executeWorkbenchPurge(workbench, plan, { dryRun: false });
      runReport.purge = {
        deleted: purgeResult.deleted.length,
        bytesFreed: purgeResult.bytesFreed,
        errors: purgeResult.errors.length,
      };
      purgeErrors = purgeResult.errors.length;
      log(
        `purge deleted ${purgeResult.deleted.length}, freed ${(purgeResult.bytesFreed / 1024).toFixed(1)} KiB`,
      );
    }

    const finalOutcome = decideDailyFinalOutcome({
      capFilled: runReport.capFilled,
      terminationReason: runReport.terminationReason,
      exportErrors: exportResult.errors.length,
      purgeErrors,
    });
    runReport.terminationReason = finalOutcome.reason;
    persistReport(finalOutcome.status, { finishedAt: new Date().toISOString() });
    if (finalOutcome.exitCode !== 0) return finalOutcome.exitCode;
    log("done");
    return finalOutcome.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runReport.terminationReason = "fatal_error";
    try {
      persistReport("failed", {
        finishedAt: new Date().toISOString(),
        error: message,
      });
    } catch {
      /* Preserve the original error when state storage is unavailable. */
    }
    log(`fatal: ${message}`);
    return 1;
  } finally {
    cleanup();
    process.removeListener("exit", cleanup);
  }
}

function isMainModule() {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath));
}

if (isMainModule()) {
  try {
    process.exitCode = await runDailyJuno();
  } catch (error) {
    process.stderr.write(
      `[daily-juno] fatal startup error: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
