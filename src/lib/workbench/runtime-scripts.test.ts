import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  advanceRetryState,
  decideRunStartup,
  isMissionNoProgressExit,
  MAX_MISSION_LIVE_TIMEOUT_MS,
  missionLiveTimeoutMs,
  normalizeMissionChildResult,
  parseUnblockRunId,
  validateRunState,
  verifyTerminationWasUnconfirmed,
} from "../../../scripts/run-mission-loop.mjs";
import {
  advanceDaemonFailureBudget,
  decideDaemonStartup,
  initialDaemonState,
  normalizeRuntimeChildResult,
  normalizeSpawnExit,
  parseDaemonArgs,
  validateDaemonState,
  writeDaemonStateAtomic,
} from "../../../scripts/run-juno-daemon.mjs";
import {
  advanceDailyBudgets,
  decideDailyStartup,
  decideDailyFinalOutcome,
  inspectDailyRunState,
  normalizeDailyChildResult,
  normalizeDailyTickExit,
  parseDailyArgs,
  validateDailySchedule,
  validateDailyScheduleFile,
} from "../../../scripts/run-daily-juno.mjs";
import {
  AUTONOMY_TICK_PARENT_TIMEOUT_MS,
  MAX_AUTONOMY_TICK_TIMEOUT_MS,
  normalizeAutonomyChildResult,
} from "../../../scripts/juno-autonomy-tick.mjs";
import {
  processIsAlive,
  spawnWithTimeout,
} from "../../../scripts/lib/specialized-loop-guard.mjs";
import {
  acquireDaemonLifecycleLock,
  canonicalDaemonRoots,
  createDaemonIdentity,
  daemonControlPaths,
  inspectDaemonV2Control,
  MAX_DAEMON_LEASE_BYTES,
  MAX_DAEMON_PID_BYTES,
  MAX_DAEMON_STATE_BYTES,
  publishDaemonControlJson,
  publishDaemonControlText,
  releaseDaemonLifecycleLock,
  removeDaemonControlSnapshot,
} from "../../../scripts/lib/daemon-control.mjs";

describe("mission runtime state", () => {
  it("validates numeric retry state and bounds maxRetries", () => {
    const valid = { retryCount: 1, slotIndex: 2, maxRetries: 3, lastStatus: "failed" };
    expect(validateRunState(valid)).toBe(valid);
    expect(() => validateRunState({ ...valid, retryCount: "1" })).toThrow(/retryCount/);
    expect(() => validateRunState({ ...valid, retryCount: 4 })).toThrow(/exceed/);
    expect(() => validateRunState({ ...valid, maxRetries: -1 })).toThrow(/maxRetries/);
    expect(() => validateRunState({ ...valid, maxRetries: 21 })).toThrow(/maxRetries/);
    expect(() => validateRunState({ ...valid, slotIndex: 1.5 })).toThrow(/slotIndex/);
  });

  it("treats launcher and slot contention as no-progress without entering retry", () => {
    expect(isMissionNoProgressExit(4)).toBe(true);
    expect(isMissionNoProgressExit(1)).toBe(false);

    const missionSource = readFileSync(
      path.join(process.cwd(), "scripts", "run-mission-loop.mjs"),
      "utf8",
    );
    const launcherAcquire = missionSource.indexOf(
      "let launcherLease = acquireRunLauncherLease(workbench, head.id)",
    );
    const materialize = missionSource.indexOf("manifestPath = materializeQueueRun(head)");
    const busyChild = missionSource.indexOf("isMissionNoProgressExit(spawnOutcome.exitCode)");
    const retryChild = missionSource.indexOf("if (spawnOutcome.exitCode !== 0)");
    expect(launcherAcquire).toBeGreaterThan(-1);
    expect(launcherAcquire).toBeLessThan(materialize);
    expect(busyChild).toBeLessThan(retryChild);

    const schedulerSource = readFileSync(
      path.join(process.cwd(), "orchestrator", "src", "scheduler-daemon.ts"),
      "utf8",
    );
    expect(schedulerSource.indexOf("ensureLauncher(next.id)")).toBeLessThan(
      schedulerSource.indexOf("materializeQueueRun(next)"),
    );
  });

  it("detects unconfirmed verify termination before the ordinary retry path", () => {
    const runDir = mkdtempSync(path.join(os.tmpdir(), "juno-unconfirmed-verify-"));
    writeFileSync(
      path.join(runDir, "verify-artifact.json"),
      JSON.stringify({
        terminationConfirmed: false,
        steps: [{ terminationConfirmed: false }],
      }),
      "utf8",
    );
    expect(verifyTerminationWasUnconfirmed(runDir)).toBe(true);
    writeFileSync(
      path.join(runDir, "verify-artifact.json"),
      JSON.stringify({
        terminationConfirmed: true,
        steps: [{ terminationConfirmed: true }],
      }),
      "utf8",
    );
    expect(verifyTerminationWasUnconfirmed(runDir)).toBe(false);
    writeFileSync(path.join(runDir, "verify-artifact.json"), "{", "utf8");
    expect(verifyTerminationWasUnconfirmed(runDir)).toBe(true);

    const missionSource = readFileSync(
      path.join(process.cwd(), "scripts", "run-mission-loop.mjs"),
      "utf8",
    );
    expect(missionSource.indexOf("verifyTerminationWasUnconfirmed(runDir)")).toBeLessThan(
      missionSource.indexOf("if (spawnOutcome.exitCode !== 0)"),
    );
  });

  it("keeps blocked terminal across restart until an exact run id unblocks it", () => {
    const state = { retryCount: 3, slotIndex: 4, maxRetries: 3, lastStatus: "blocked" };
    expect(decideRunStartup("run-1", { kind: "valid", state }, null)).toMatchObject({
      action: "block",
    });
    expect(decideRunStartup("run-1", { kind: "valid", state }, "run-2")).toMatchObject({
      action: "block",
    });
    expect(
      decideRunStartup("run-1", { kind: "valid", state }, "run-1", "2026-01-01T00:00:00Z"),
    ).toEqual({
      action: "reset",
      state: {
        retryCount: 0,
        slotIndex: 4,
        maxRetries: 3,
        lastStatus: "unblocked",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    expect(
      decideRunStartup(
        "run-1",
        { kind: "missing" },
        null,
        "2026-01-01T00:00:00Z",
        true,
      ),
    ).toMatchObject({ action: "block" });
    expect(
      decideRunStartup(
        "run-1",
        { kind: "missing" },
        "run-1",
        "2026-01-01T00:00:00Z",
        true,
      ),
    ).toMatchObject({ action: "reset", state: { lastStatus: "unblocked" } });
    const emptyEnv = {} as NodeJS.ProcessEnv;
    expect(parseUnblockRunId(["--unblock-run=run-1"], emptyEnv)).toBe("run-1");
    expect(() => parseUnblockRunId(["--unblock-run=../outside"], emptyEnv)).toThrow(/invalid/);
  });

  it("derives revision attempts from persisted lineage instead of wall-clock time", () => {
    const missionSource = readFileSync(
      path.join(process.cwd(), "scripts", "run-mission-loop.mjs"),
      "utf8",
    );
    expect(missionSource).toContain("nextRevisionAttempt(");
    expect(missionSource).toContain("readWorkflowExperimentRevisionPromptBinding(");
    expect(missionSource).not.toContain("buildReviseImplementItem(head, Date.now()");

    const schedulerSource = readFileSync(
      path.join(process.cwd(), "orchestrator", "src", "scheduler-daemon.ts"),
      "utf8",
    );
    expect(schedulerSource).toContain("nextRevisionAttempt(");
    expect(schedulerSource).toContain("readWorkflowExperimentRevisionPromptBinding(");
    expect(schedulerSource).not.toContain("buildReviseImplementItem(head, Date.now()");

    const bookSource = readFileSync(
      path.join(process.cwd(), "scripts", "lib", "book-advance-core.mjs"),
      "utf8",
    );
    expect(bookSource).toContain("nextRevisionAttempt(");
    expect(bookSource).not.toContain("buildReviseImplementItem(head, Date.now()");
    expect(bookSource).not.toContain("fix.prompt =");
    expect(bookSource).not.toContain("fix.repo_target =");
    expect(bookSource).not.toContain("fix.phase_id =");
  });

  it("reconciles completion intents before every runtime can execute a new queue head", () => {
    const sources = [
      ["scripts/run-mission-loop.mjs", "finalizeOrdinaryVerifyQueueHead", "let queueSnapshot = readNowQueueSnapshot(workbench)"],
      ["scripts/run-minimal-loop.mjs", "finalizeOrdinaryVerifyQueueHead", "let { now } = readNowQueueSnapshot(workbench)"],
      ["scripts/run-agi-literature-loop.mjs", "finalizeSpecializedVerifyQueueHead", "for (let i = 0; i < maxSlots; i++)"],
      ["scripts/run-axiom-book-loop.mjs", "finalizeSpecializedVerifyQueueHead", "for (let i = 0; i < maxSlots; i++)"],
      ["orchestrator/src/scheduler-daemon.ts", "finalizeOrdinaryVerifyQueueHead", "const orch = readOrchestrator()"],
    ] as const;
    for (const [relativePath, finalizeName, executionMarker] of sources) {
      const source = readFileSync(path.join(process.cwd(), relativePath), "utf8");
      const recovery = source.indexOf("recoverPendingVerifyCompletions(workbench)");
      const firstQueueRead = source.indexOf(executionMarker, recovery);
      expect(recovery, relativePath).toBeGreaterThan(-1);
      expect(recovery, relativePath).toBeLessThan(firstQueueRead);
      if (relativePath.includes("agi-literature") || relativePath.includes("axiom-book")) {
        const corePath = relativePath.includes("agi-literature")
          ? "scripts/lib/agi-advance-core.mjs"
          : "scripts/lib/book-advance-core.mjs";
        expect(readFileSync(path.join(process.cwd(), corePath), "utf8"), corePath)
          .toContain(finalizeName);
      } else {
        expect(source, relativePath).toContain(finalizeName);
      }
    }
  });

  it("blocks only after the configured retry budget is consumed", () => {
    const beforeFinalRetry = { retryCount: 2, slotIndex: 3, maxRetries: 3 };
    expect(advanceRetryState(beforeFinalRetry, "t1")).toEqual({
      blocked: false,
      state: {
        retryCount: 3,
        slotIndex: 3,
        maxRetries: 3,
        lastStatus: "failed",
        updatedAt: "t1",
      },
    });
    expect(
      advanceRetryState({ ...beforeFinalRetry, retryCount: 3 }, "t2"),
    ).toMatchObject({ blocked: true, state: { lastStatus: "blocked" } });
  });

  it("derives the live deadline from the validated manifest budget", () => {
    expect(missionLiveTimeoutMs(45)).toBe(50 * 60_000);
    expect(missionLiveTimeoutMs(240)).toBe(245 * 60_000);
    expect(MAX_AUTONOMY_TICK_TIMEOUT_MS).toBeGreaterThanOrEqual(
      MAX_MISSION_LIVE_TIMEOUT_MS * 2,
    );
    expect(AUTONOMY_TICK_PARENT_TIMEOUT_MS).toBeGreaterThan(
      MAX_AUTONOMY_TICK_TIMEOUT_MS,
    );
    expect(() => missionLiveTimeoutMs(0)).toThrow(/maxMinutes/);
    expect(() => missionLiveTimeoutMs(241)).toThrow(/maxMinutes/);
  });
});

describe("master daemon runtime", () => {
  it("validates interval and failure-budget arguments", () => {
    expect(parseDaemonArgs([])).toMatchObject({
      intervalMs: 120_000,
      maxConsecutiveFailures: 3,
    });
    expect(
      parseDaemonArgs(["--interval-ms=1000", "--max-consecutive-failures=4"]),
    ).toMatchObject({ intervalMs: 1_000, maxConsecutiveFailures: 4 });
    expect(() => parseDaemonArgs(["--interval-ms=0"])).toThrow(/interval-ms/);
    expect(() => parseDaemonArgs(["--interval-ms=NaN"])).toThrow(/interval-ms/);
    expect(() => parseDaemonArgs(["--max-consecutive-failures=0"])).toThrow(
      /max-consecutive-failures/,
    );
  });

  it("turns null and persistent unknown exits into a finite terminal failure", () => {
    expect(normalizeSpawnExit(null)).toBe(1);
    let budget = advanceDaemonFailureBudget(0, normalizeSpawnExit(null), 3);
    expect(budget).toEqual({ consecutiveFailures: 1, exhausted: false });
    budget = advanceDaemonFailureBudget(budget.consecutiveFailures, 1, 3);
    expect(budget).toEqual({ consecutiveFailures: 2, exhausted: false });
    budget = advanceDaemonFailureBudget(budget.consecutiveFailures, 137, 3);
    expect(budget).toEqual({ consecutiveFailures: 3, exhausted: true });
    expect(advanceDaemonFailureBudget(0, 2, 3)).toEqual({
      consecutiveFailures: 1,
      exhausted: false,
    });
    expect(advanceDaemonFailureBudget(2, 3, 3)).toEqual({
      consecutiveFailures: 0,
      exhausted: false,
    });
  });

  it("requires explicit recovery and creates a drift-free initial state", () => {
    const prior = {
      kind: "valid",
      state: {
        status: "blocked",
        blockedReason: "terminal mission gate",
        blockedRunId: "run-1",
        lastCapDetail: "stale",
      },
    };
    const config = {
      intervalMs: 120_000,
      maxConsecutiveFailures: 3,
      unblockDaemon: false,
      unblockRunId: null,
    };
    expect(decideDaemonStartup(prior, config)).toMatchObject({ action: "block" });
    expect(
      decideDaemonStartup(prior, {
        ...config,
        unblockDaemon: true,
        unblockRunId: "other-run",
      }),
    ).toMatchObject({ action: "block" });
    expect(
      decideDaemonStartup(prior, {
        ...config,
        unblockDaemon: true,
        unblockRunId: "run-1",
      }),
    ).toEqual({ action: "continue", carriedFailures: 0 });
    expect(
      decideDaemonStartup(
        { kind: "valid", state: { status: "degraded", consecutiveFailures: 2 } },
        config,
      ),
    ).toEqual({ action: "continue", carriedFailures: 2 });
    expect(
      decideDaemonStartup(
        { kind: "valid", state: { status: "stopped", consecutiveFailures: 2 } },
        config,
      ),
    ).toEqual({ action: "continue", carriedFailures: 2 });

    expect(initialDaemonState("now", 1, true)).toMatchObject({
      status: "running",
      consecutiveFailures: 1,
      waitUntil: null,
      waitRemainingMs: null,
      lastCapDetail: null,
      blockedReason: null,
      blockedRunId: null,
      lastError: null,
      unblockedAt: "now",
    });
  });

  it("validates daemon status strictly and atomically replaces state", () => {
    expect(() =>
      validateDaemonState({ status: "Stopped", consecutiveFailures: 2 }),
    ).toThrow(/status/);
    expect(() => validateDaemonState({ status: "stopped" })).toThrow(/consecutiveFailures/);

    const stateDir = mkdtempSync(path.join(os.tmpdir(), "juno-daemon-atomic-"));
    const statePath = path.join(stateDir, "juno-daemon.json");
    const initial = initialDaemonState("2026-07-11T00:00:00.000Z", 1, false);
    writeDaemonStateAtomic(statePath, initial);
    writeDaemonStateAtomic(statePath, { ...initial, status: "stopped", consecutiveFailures: 2 });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      status: "stopped",
      consecutiveFailures: 2,
    });
  });

  it("binds v2 state, lease, PID shadow, process identity, and Workbench", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "juno-daemon-v2-contract-"));
    const { workbenchRoot, stateDir } = canonicalDaemonRoots(root, true);
    const paths = daemonControlPaths(stateDir);
    const identity = createDaemonIdentity(workbenchRoot);
    const now = new Date().toISOString();
    const state = initialDaemonState(now, 0, false, identity);
    const leaseSnapshot = publishDaemonControlJson(
      paths.lease,
      { ...identity, acquiredAt: now },
      "Daemon lease",
      MAX_DAEMON_LEASE_BYTES,
    );
    const pidSnapshot = publishDaemonControlText(
      paths.pid,
      `${process.pid}\n`,
      "Daemon legacy PID shadow",
      MAX_DAEMON_PID_BYTES,
    );
    const stateSnapshot = publishDaemonControlJson(
      paths.state,
      state,
      "Daemon state",
      MAX_DAEMON_STATE_BYTES,
    );

    expect(readFileSync(paths.pid, "utf8")).toBe(`${process.pid}\n`);
    expect(inspectDaemonV2Control(workbenchRoot, stateDir)).toMatchObject({
      kind: "v2",
      live: true,
      identity: {
        protocolVersion: 2,
        generation: identity.generation,
        pid: process.pid,
        processStartedAt: identity.processStartedAt,
        workbenchRoot,
      },
    });

    removeDaemonControlSnapshot(
      paths.pid,
      "Daemon legacy PID shadow",
      MAX_DAEMON_PID_BYTES,
      pidSnapshot,
    );
    removeDaemonControlSnapshot(
      paths.lease,
      "Daemon lease",
      MAX_DAEMON_LEASE_BYTES,
      leaseSnapshot,
    );
    removeDaemonControlSnapshot(
      paths.state,
      "Daemon state",
      MAX_DAEMON_STATE_BYTES,
      stateSnapshot,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("allows exactly one lifecycle owner and rejects a concurrent second owner", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "juno-daemon-lifecycle-owner-"));
    const { stateDir } = canonicalDaemonRoots(root, true);
    const owner = acquireDaemonLifecycleLock(stateDir, "test-owner");
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "lib", "daemon-control.mjs"),
    ).href;
    const contender = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { acquireDaemonLifecycleLock } from ${JSON.stringify(moduleUrl)}; try { acquireDaemonLifecycleLock(process.env.STATE_DIR, "test-contender", { timeoutMs: 100, handoffToken: null }); process.exit(0); } catch { process.exit(7); }`,
      ],
      {
        env: { ...process.env, STATE_DIR: stateDir },
        encoding: "utf8",
        shell: false,
      },
    );
    expect(contender.status).toBe(7);
    releaseDaemonLifecycleLock(owner);
    expect(existsSync(daemonControlPaths(stateDir).lifecycle)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves foreign state, lease, and PID replacements during cleanup", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "juno-daemon-cleanup-cas-"));
    const { stateDir } = canonicalDaemonRoots(root, true);
    const paths = daemonControlPaths(stateDir);
    const controls = [
      [paths.state, "Daemon state", MAX_DAEMON_STATE_BYTES],
      [paths.lease, "Daemon lease", MAX_DAEMON_LEASE_BYTES],
      [paths.pid, "Daemon PID", MAX_DAEMON_PID_BYTES],
    ] as const;

    for (const [target, label, maxBytes] of controls) {
      const snapshot = publishDaemonControlText(target, "owned\n", label, maxBytes);
      removeDaemonControlSnapshot(target, label, maxBytes, snapshot, {
        afterClaim: () => writeFileSync(target, "foreign\n", { flag: "wx" }),
      });
      expect(readFileSync(target, "utf8")).toBe("foreign\n");
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a blocked daemon in a fresh process before taking a lock or PID", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-daemon-blocked-"));
    const stateDir = path.join(workbench, "state");
    mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, "juno-daemon.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        status: "blocked",
        blockedReason: "failure budget exhausted",
        blockedRunId: null,
        consecutiveFailures: 3,
      }),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "scripts", "run-juno-daemon.mjs")],
      {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench },
        encoding: "utf8",
        shell: false,
      },
    );

    expect(result.status).toBe(5);
    expect(result.stderr).toContain("blocked across restart");
    expect(result.stderr).toContain("--unblock-daemon");
    expect(existsSync(path.join(stateDir, "juno-daemon.pid"))).toBe(false);
    expect(existsSync(path.join(stateDir, "juno-daemon.lease.json"))).toBe(false);
    expect(existsSync(path.join(stateDir, "juno-daemon.lifecycle.lock.json"))).toBe(false);
    expect(existsSync(path.join(stateDir, "autonomy.lock.json"))).toBe(false);
    expect(JSON.parse(readFileSync(statePath, "utf8")).status).toBe("blocked");
  });
});

describe("daily batch runtime", () => {
  const baseSchedule = {
    enabled: true,
    startHourLocal: 0,
    tickIntervalMs: 120_000,
    maxIterationsPerDay: null,
    maxIdleTicks: null,
    exportRoot: "E:\\JunoDailyExport",
    purgeAfterRun: true,
    exportRetentionDays: 30,
  };

  it("uses finite defaults and rejects invalid numeric schedule values", () => {
    expect(validateDailySchedule(baseSchedule, 12)).toMatchObject({
      intervalMs: 120_000,
      maxIterations: 12,
      maxIdleTicks: 5,
    });
    expect(() =>
      validateDailySchedule({ ...baseSchedule, tickIntervalMs: 0 }, 12),
    ).toThrow(/tickIntervalMs/);
    expect(() =>
      validateDailySchedule({ ...baseSchedule, maxIterationsPerDay: Number.NaN }, 12),
    ).toThrow(/maxIterationsPerDay/);
    expect(() =>
      validateDailySchedule({ ...baseSchedule, maxIdleTicks: -1 }, 12),
    ).toThrow(/maxIdleTicks/);
    expect(() =>
      validateDailySchedule({ ...baseSchedule, maxIdleTicks: 101 }, 12),
    ).toThrow(/maxIdleTicks/);
    expect(() => parseDailyArgs(["--max-consecutive-failures=0"])).toThrow(
      /max-consecutive-failures/,
    );

    const malformedWorkbench = mkdtempSync(path.join(os.tmpdir(), "juno-daily-config-"));
    mkdirSync(path.join(malformedWorkbench, "config"), { recursive: true });
    writeFileSync(path.join(malformedWorkbench, "config", "daily-schedule.json"), "{", "utf8");
    expect(() => validateDailyScheduleFile(malformedWorkbench)).toThrow(/valid JSON/);
  });

  it("keeps dry-run read-only even when book-quality maintenance can be synchronized", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-daily-dry-run-"));
    const exportRoot = mkdtempSync(path.join(os.tmpdir(), "juno-daily-export-"));
    const stateDir = path.join(workbench, "state");
    const missionDir = path.join(workbench, "missions", "juno-book-quality-2026");
    mkdirSync(path.join(workbench, "config"), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(missionDir, { recursive: true });
    writeFileSync(
      path.join(workbench, "config", "daily-schedule.json"),
      `${JSON.stringify({ ...baseSchedule, exportRoot })}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(stateDir, "quality-scan.json"),
      `${JSON.stringify({ scannedAt: new Date().toISOString(), failedChapters: [] })}\n`,
      "utf8",
    );
    const dailyStatePath = path.join(stateDir, "daily-juno.json");
    const sentinel = "{\"status\":\"blocked\",\"sentinel\":true}\n";
    writeFileSync(dailyStatePath, sentinel, "utf8");

    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "scripts", "run-daily-juno.mjs"), "--dry-run"],
      {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench },
        encoding: "utf8",
        shell: false,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(dailyStatePath, "utf8")).toBe(sentinel);
    expect(existsSync(path.join(missionDir, "checkpoint.md"))).toBe(false);
    expect(existsSync(path.join(stateDir, "daily-juno.pid"))).toBe(false);
    expect(existsSync(path.join(stateDir, "autonomy.lock.json"))).toBe(false);
  }, 60_000);

  it("bounds nonzero, null, idle, and no-progress ticks", () => {
    expect(normalizeDailyTickExit(null)).toBe(1);
    const limits = { maxConsecutiveFailures: 2, maxIdleTicks: 3 };
    const first = advanceDailyBudgets(
      { failureStreak: 0, noProgressStreak: 0, idleStreak: 0 },
      { tickExit: 1, iterationsBefore: 0, iterationsAfter: 0, plannerAction: null },
      limits,
    );
    expect(first).toMatchObject({
      failureStreak: 1,
      noProgressStreak: 1,
      terminalReason: null,
    });
    expect(
      advanceDailyBudgets(
        first,
        { tickExit: 2, iterationsBefore: 0, iterationsAfter: 0, plannerAction: null },
        limits,
      ),
    ).toMatchObject({ terminalReason: "consecutive_tick_failures" });

    const idle = advanceDailyBudgets(
      { failureStreak: 0, noProgressStreak: 2, idleStreak: 2 },
      { tickExit: 0, iterationsBefore: 0, iterationsAfter: 0, plannerAction: "stop" },
      limits,
    );
    expect(idle.terminalReason).toBe("idle_limit");
  });

  it("never reports complete unless the cap and post-run operations succeeded", () => {
    expect(
      decideDailyFinalOutcome({ capFilled: false, terminationReason: "idle_limit" }),
    ).toEqual({ status: "blocked", exitCode: 5, reason: "idle_limit" });
    expect(decideDailyFinalOutcome({ capFilled: true, exportErrors: 1 })).toEqual({
      status: "failed",
      exitCode: 1,
      reason: "export_failed",
    });
    expect(decideDailyFinalOutcome({ capFilled: true, purgeErrors: 1 })).toEqual({
      status: "failed",
      exitCode: 1,
      reason: "purge_failed",
    });
    expect(decideDailyFinalOutcome({ capFilled: true })).toEqual({
      status: "complete",
      exitCode: 0,
      reason: "daily_iteration_cap",
    });
  });

  it("carries same-day budgets and keeps terminal daily state blocked across restart", () => {
    const limits = { maxConsecutiveFailures: 3, maxIdleTicks: 5 };
    const interrupted = {
      kind: "valid" as const,
      state: {
        status: "interrupted",
        autonomyDate: "2026-07-11",
        failureStreak: 2,
        noProgressStreak: 2,
        idleStreak: 0,
      },
    };
    expect(decideDailyStartup(interrupted, "2026-07-11", limits)).toEqual({
      action: "continue",
      budgets: { failureStreak: 2, noProgressStreak: 2, idleStreak: 0 },
    });
    expect(decideDailyStartup(interrupted, "2026-07-12", limits)).toEqual({
      action: "continue",
      budgets: { failureStreak: 0, noProgressStreak: 0, idleStreak: 0 },
    });

    const blocked = {
      kind: "valid" as const,
      state: {
        status: "blocked",
        autonomyDate: "2026-07-11",
        blockedReason: "no_progress_limit",
      },
    };
    expect(decideDailyStartup(blocked, "2026-07-11", limits)).toEqual({
      action: "block",
      reason: "no_progress_limit",
    });
    expect(decideDailyStartup(blocked, "2026-07-11", limits, true)).toEqual({
      action: "continue",
      budgets: { failureStreak: 0, noProgressStreak: 0, idleStreak: 0 },
    });

    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-daily-state-"));
    const statePath = path.join(workbench, "daily-juno.json");
    writeFileSync(statePath, "{", "utf8");
    expect(inspectDailyRunState(statePath)).toMatchObject({ kind: "invalid" });
    expect(
      decideDailyStartup(inspectDailyRunState(statePath), "2026-07-11", limits),
    ).toMatchObject({ action: "block" });
  });
});

describe("runtime child boundaries", () => {
  it("reserves autonomy budget before dispatch and settles from the finally path", () => {
    const source = readFileSync(
      path.join(process.cwd(), "scripts", "juno-autonomy-tick.mjs"),
      "utf8",
    );
    const reserve = source.indexOf("reserveAutonomyDecision(workbench, decision)");
    const firstDispatch = source.indexOf('if (decision.action === "run_local_loop")');
    expect(reserve).toBeGreaterThan(-1);
    expect(reserve).toBeLessThan(firstDispatch);
    expect(source).toContain("settlePendingReservation?.()");
    expect(source).not.toContain("recordAutonomyDecision(workbench, decision");
  });

  it("normalizes null status, signals, timeouts, and spawn errors as failures", () => {
    const normalizers = [
      normalizeRuntimeChildResult,
      normalizeDailyChildResult,
      normalizeMissionChildResult,
      normalizeAutonomyChildResult,
    ];
    for (const normalize of normalizers) {
      expect(normalize({ status: 0 }, "child")).toEqual({ exitCode: 0, error: null });
      expect(normalize({ status: null, signal: "SIGKILL" }, "child").exitCode).toBe(1);
      expect(normalize({ status: 0, signal: "SIGTERM" }, "child").exitCode).toBe(1);
      expect(normalize({ status: 0, timedOut: true }, "child").exitCode).toBe(1);
      expect(
        normalize({ status: 0, error: new Error("spawn failed") }, "child").exitCode,
      ).toBe(1);
      expect(
        normalize({ status: null, timedOut: true, error: new Error("timeout") }, "child")
          .exitCode,
      ).toBe(1);
    }
    expect(
      normalizeAutonomyChildResult(
        { status: 0, terminationConfirmed: false },
        "autonomy child",
      ).exitCode,
    ).toBe(1);
  });

  it(
    "aborts a hanging active child when shutdown is requested",
    async () => {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), "juno-signal-tree-"));
      const grandchildPidPath = path.join(stateDir, "grandchild.pid");
      const childScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "fs.writeFileSync(process.argv[1], String(child.pid));",
        "setInterval(() => {}, 1000);",
      ].join(" ");
      const controller = new AbortController();
      const pending = spawnWithTimeout(
        process.execPath,
        ["-e", childScript, grandchildPidPath],
        { stdio: "ignore", signal: controller.signal },
        10_000,
      );
      for (let attempt = 0; attempt < 100 && !existsSync(grandchildPidPath); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(existsSync(grandchildPidPath)).toBe(true);
      const grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
      controller.abort();
      const result = await pending;
      expect(result.status).not.toBe(0);
      expect(result.error?.code).toBe("ABORT_ERR");
      for (let attempt = 0; attempt < 100 && processIsAlive(grandchildPid); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(processIsAlive(grandchildPid)).toBe(false);
    },
    10_000,
  );

  it("keeps every runtime subprocess on a finite deadline", () => {
    const files = [
      "scripts/run-juno-daemon.mjs",
      "scripts/run-daily-juno.mjs",
      "scripts/juno-autonomy-tick.mjs",
      "scripts/run-mission-loop.mjs",
    ];
    for (const file of files) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/\bspawnSync\b|\bspawnPnpmSync\b/);
      expect(source).toContain("spawnWithTimeout");
      expect(source).toContain("spawnPnpmWithTimeout");
      expect(source).toContain("signal:");
      expect(source).toMatch(/TIMEOUT_MS/);
    }
  });
});
