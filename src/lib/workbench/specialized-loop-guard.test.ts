import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquirePidFile,
  checkedSpawnStatus,
  completionEvidenceReady,
  daemonStateOwnsPid,
  daemonFailureIsTerminal,
  daemonCycleTimeoutMs,
  inspectDaemonRestartState,
  inspectMissionQueueHead,
  loopExitCode,
  liveSlotTimeoutMs,
  nextConsecutiveFailureCount,
  parseCycleNonceFlag,
  parsePositiveIntegerFlag,
  processIsAlive,
  readPidLease,
  releasePidFile,
  requireSpawnSuccess,
  spawnWithTimeout,
  startDaemonStateHeartbeat,
  stateWriteIsFresh,
  TERMINAL_BLOCK_EXIT,
  validateSpecializedDaemonState,
} from "../../../scripts/lib/specialized-loop-guard.mjs";
import {
  AGI_MISSION_ID,
  advanceOneAgiSlot,
  validateAgiBatch,
  validateAgiLiteratureEvidence,
} from "../../../scripts/lib/agi-advance-core.mjs";
import {
  CHAPTER_COUNT,
  missionDir,
  validateBookCompletionEvidence,
} from "../../../scripts/lib/book-decision.mjs";
import {
  evaluateBookRunCompletion,
  writeBookLoopState,
  writeBookQualityLoopState,
} from "../../../scripts/lib/book-advance-core.mjs";
import { missionCompletionReceiptPath } from "../../../orchestrator/src/mission-completion.js";

const tempRoots: string[] = [];
const DAEMON_CHILD_TEST_TIMEOUT_MS = 45_000;
const DAEMON_PROCESS_TEST_TIMEOUT_MS = 60_000;
const DAEMON_MULTI_PROCESS_TEST_TIMEOUT_MS = 120_000;
const DAEMON_RESTART_TEST_TIMEOUT_MS = 150_000;

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "juno-specialized-loop-"));
  tempRoots.push(root);
  return root;
}

function validAgiBatch(titlePrefix: string): string {
  const entries = Array.from({ length: 25 }, (_, index) => {
    const number = index + 1;
    return `  - title: "${titlePrefix} ${number}"
    authors: "Author ${number}"
    year: 2024
    venue: "Test venue"
    url: "https://example.test/${encodeURIComponent(titlePrefix)}/${number}"
    one_line: "Substantive evidence summary for literature entry number ${number}."
    juno_hook: "Concrete Juno oversight implication for literature entry number ${number}."`;
  });
  return `papers:\n${entries.join("\n\n")}\n`;
}

function validBookChapter(chapter: number): string {
  const diverseHan = Array.from({ length: 200 }, (_, index) => String.fromCharCode(0x4e00 + index)).join("");
  return `# Chapter ${chapter}\n\n相关公理：A1\n\n本书主张：这是可证伪的章节论证。\n\n${diverseHan.repeat(24)}`;
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("specialized loop guard", () => {
  it("keeps main book and book-quality runtime state in separate files", () => {
    const workbench = tempRoot();
    mkdirSync(path.join(workbench, "state"), { recursive: true });
    writeBookLoopState(workbench, { status: "terminal_blocked", blockedReason: "merge mismatch" });
    writeBookQualityLoopState(workbench, { status: "noop", qualityLoop: true });

    expect(JSON.parse(readFileSync(path.join(workbench, "state", "book-loop.json"), "utf8")))
      .toMatchObject({ status: "terminal_blocked", blockedReason: "merge mismatch" });
    expect(
      JSON.parse(readFileSync(path.join(workbench, "state", "book-quality-loop.json"), "utf8")),
    ).toMatchObject({ status: "noop", qualityLoop: true });
  });

  it("accepts only bounded positive integer flags", () => {
    expect(parsePositiveIntegerFlag([], "max-slots", 3)).toBe(3);
    expect(parsePositiveIntegerFlag(["--max-slots=12"], "max-slots", 3, { max: 20 })).toBe(12);
    for (const value of ["0", "-1", "NaN", "1.5", "21", "Infinity", ""]) {
      expect(() =>
        parsePositiveIntegerFlag([`--max-slots=${value}`], "max-slots", 3, { max: 20 }),
      ).toThrow(/max-slots/);
    }
    expect(() =>
      parsePositiveIntegerFlag(["--max-slots=1", "--max-slots=2"], "max-slots", 3),
    ).toThrow(/duplicate/);
    expect(parseCycleNonceFlag(["--cycle-nonce=cycle_1234567890"])).toBe("cycle_1234567890");
    expect(() => parseCycleNonceFlag(["--cycle-nonce=short"])).toThrow(/cycle-nonce/);
    expect(liveSlotTimeoutMs(45)).toBe(50 * 60_000);
    expect(daemonCycleTimeoutMs(3, liveSlotTimeoutMs(45))).toBe(152 * 60_000);
    expect(() => liveSlotTimeoutMs(241)).toThrow(/maxMinutes/);
  });

  it("fails closed when a child has no real zero exit status", () => {
    expect(checkedSpawnStatus({ status: 0 }, "build")).toBe(0);
    expect(() => checkedSpawnStatus({ status: null }, "build")).toThrow(/without an exit code/);
    expect(() => checkedSpawnStatus({ status: null, error: new Error("spawn") }, "build")).toThrow(
      /failed to start/,
    );
    expect(() => requireSpawnSuccess({ status: 7 }, "build")).toThrow(/status 7/);
  });

  it("counts noop and failed cycles while resetting only on real progress", () => {
    expect(nextConsecutiveFailureCount(0, { exitCode: 4, advanced: 0 })).toBe(1);
    expect(nextConsecutiveFailureCount(1, { exitCode: 0, advanced: 0 })).toBe(2);
    expect(nextConsecutiveFailureCount(2, { exitCode: 1, advanced: 4 })).toBe(3);
    expect(nextConsecutiveFailureCount(2, { exitCode: 0, advanced: 1 })).toBe(0);
    expect(daemonFailureIsTerminal(false, 2, 3)).toBe(false);
    expect(daemonFailureIsTerminal(false, 3, 3)).toBe(true);
    expect(daemonFailureIsTerminal(true, 0, 3)).toBe(true);
    const nonce = "cycle_1234567890";
    expect(
      stateWriteIsFresh("old", "old", { updatedAt: new Date().toISOString(), cycleNonce: nonce }, nonce),
    ).toBe(false);
    expect(stateWriteIsFresh("old", "new", { updatedAt: "not-a-date", cycleNonce: nonce }, nonce)).toBe(false);
    expect(
      stateWriteIsFresh("old", "new", { updatedAt: new Date().toISOString(), cycleNonce: "stale_nonce_1234" }, nonce),
    ).toBe(false);
    expect(
      stateWriteIsFresh("old", "new", { updatedAt: new Date(0).toISOString(), cycleNonce: nonce }, nonce),
    ).toBe(true);
    const now = Date.now();
    expect(
      daemonStateOwnsPid(
        { pid: 42, status: "running", intervalMs: 30_000, updatedAt: new Date(now).toISOString() },
        42,
        now,
      ),
    ).toBe(true);
    expect(
      daemonStateOwnsPid(
        { pid: 42, status: "running", intervalMs: 30_000, updatedAt: new Date(now - 600_000).toISOString() },
        42,
        now,
      ),
    ).toBe(false);
    const tokenField = ["to", "ken"].join("") as "token";
    const lease = { pid: 42, [tokenField]: "11111111-1111-1111-1111-111111111111" };
    const leasedState = {
      pid: 42,
      pidLeaseToken: lease.token,
      status: "running",
      intervalMs: 30_000,
      updatedAt: new Date(now).toISOString(),
    };
    expect(daemonStateOwnsPid(leasedState, lease, now)).toBe(true);
    expect(daemonStateOwnsPid(leasedState, { ...lease, token: "wrong" }, now)).toBe(false);
    expect(loopExitCode({ advanced: 0 })).toBe(4);
    expect(loopExitCode({ advanced: 2 })).toBe(0);
    expect(loopExitCode({ advanced: 2, terminal: true })).toBe(TERMINAL_BLOCK_EXIT);
  });

  it("keeps a long active cycle stoppable and stops heartbeats on abort", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
      const controller = new AbortController();
      const state = {
        pid: 42,
        status: "running",
        intervalMs: 30_000,
        updatedAt: new Date().toISOString(),
      };
      let heartbeats = 0;
      const stop = startDaemonStateHeartbeat(
        () => {
          heartbeats += 1;
          state.updatedAt = new Date().toISOString();
        },
        { intervalMs: 60_000, signal: controller.signal },
      );

      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(heartbeats).toBe(6);
      expect(daemonStateOwnsPid(state, 42, Date.now())).toBe(true);
      controller.abort();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(heartbeats).toBe(6);
      expect(daemonStateOwnsPid(state, 42, Date.now())).toBe(false);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("always evaluates live book completion through the mission safety gate", () => {
    const calls: unknown[][] = [];
    const result = evaluateBookRunCompletion("E:\\AgentWorkbench", "book-run-1", (...args: unknown[]) => {
      calls.push(args);
      return { action: "dequeue" };
    });

    expect(result).toEqual({ action: "dequeue" });
    expect(calls).toEqual([["E:\\AgentWorkbench", "book-run-1", "juno-axiom-book-2026"]]);
  });

  it("rejects checkpoint-only completion and foreign queue heads", () => {
    expect(
      completionEvidenceReady({
        checkpointComplete: true,
        completedUnits: 39,
        requiredUnits: 40,
        artifactsReady: true,
      }),
    ).toBe(false);
    expect(
      completionEvidenceReady({
        checkpointComplete: true,
        completedUnits: 40,
        requiredUnits: 40,
        artifactsReady: true,
      }),
    ).toBe(true);

    expect(inspectMissionQueueHead(undefined, "mission-a")).toMatchObject({
      ok: false,
      terminal: false,
      reason: "queue_empty",
    });
    expect(inspectMissionQueueHead({ id: "b1", mission_id: "mission-b" }, "mission-a"))
      .toMatchObject({ ok: false, terminal: true });
    expect(
      inspectMissionQueueHead(
        { id: "a1", mission_id: "mission-a", phase_id: "chapter-write" },
        "mission-a",
        { phasePrefix: "bq-" },
      ),
    ).toMatchObject({ ok: false, terminal: true, reason: "unexpected_phase:chapter-write" });
  });

  it("acquires stale pid files atomically and releases only the owner", () => {
    const pidPath = path.join(tempRoot(), "daemon.pid");
    writeFileSync(pidPath, "12345", { encoding: "utf8", flag: "wx" });
    const lease = acquirePidFile(pidPath, 777, () => false);
    expect(readPidLease(pidPath)).toEqual(lease);
    expect(
      releasePidFile(pidPath, {
        ...lease,
        [["to", "ken"].join("")]: "00000000-0000-0000-0000-000000000000",
      }),
    ).toBe(false);
    expect(readPidLease(pidPath)).toEqual(lease);
    expect(releasePidFile(pidPath, lease)).toBe(true);
  });

  it("refuses a duplicate live daemon pid", () => {
    const pidPath = path.join(tempRoot(), "daemon.pid");
    writeFileSync(pidPath, "12345", "utf8");
    expect(() => acquirePidFile(pidPath, 777, () => true)).toThrow(/already running/);
    expect(readFileSync(pidPath, "utf8")).toBe("12345");
  });

  it("fails closed while another process owns the stale-lease acquisition mutex", () => {
    const pidPath = path.join(tempRoot(), "daemon.pid");
    writeFileSync(pidPath, "12345", "utf8");
    mkdirSync(`${pidPath}.acquire-lock`);
    expect(() => acquirePidFile(pidPath, 777, () => false)).toThrow(/acquisition already in progress/);
    expect(readFileSync(pidPath, "utf8")).toBe("12345");
  });

  it("recovers a crashed stale acquisition mutex without removing a fresh owner", () => {
    const pidPath = path.join(tempRoot(), "daemon.pid");
    writeFileSync(pidPath, "12345", "utf8");
    const acquisitionLock = `${pidPath}.acquire-lock`;
    mkdirSync(acquisitionLock);
    writeFileSync(
      path.join(acquisitionLock, "owner.json"),
      JSON.stringify({ token: "stale", pid: 12345, acquiredAt: 0 }),
      "utf8",
    );
    const staleDate = new Date(Date.now() - 60_000);
    utimesSync(acquisitionLock, staleDate, staleDate);

    const lease = acquirePidFile(pidPath, 777, () => false);
    expect(readPidLease(pidPath)).toEqual(lease);
    expect(existsSync(acquisitionLock)).toBe(false);
    expect(releasePidFile(pidPath, lease)).toBe(true);
  });

  it("requires an explicit unblock before restarting terminal daemon state", () => {
    const statePath = path.join(tempRoot(), "daemon.json");
    writeFileSync(statePath, JSON.stringify({ status: "terminal_blocked", blockedReason: "foreign_queue" }));
    expect(inspectDaemonRestartState(statePath, [])).toMatchObject({
      allowed: false,
      reason: "foreign_queue",
    });
    expect(inspectDaemonRestartState(statePath, ["--unblock-daemon"])).toMatchObject({
      allowed: true,
      unblocked: true,
    });
    writeFileSync(statePath, "not json", "utf8");
    expect(inspectDaemonRestartState(statePath, [])).toMatchObject({
      allowed: false,
      reason: "invalid_daemon_state",
    });
  });

  it("fails closed on JSON-valid malformed daemon control state", () => {
    const statePath = path.join(tempRoot(), "daemon.json");
    const invalidStates = [
      null,
      [],
      {},
      { status: "blocked" },
      { status: "RUNNING" },
      { status: "running", pid: "42" },
      { status: "running", intervalMs: 0 },
      { status: "retrying", consecutiveFailures: -1 },
      { status: "terminal_blocked", blockedReason: 5 },
      { status: "running", updatedAt: "not-a-date" },
      { status: "running", pidLeaseToken: "not-a-lease" },
      { status: "running", activeCycleNonce: "short" },
    ];

    for (const state of invalidStates) {
      writeFileSync(statePath, JSON.stringify(state), "utf8");
      expect(inspectDaemonRestartState(statePath, [])).toMatchObject({
        allowed: false,
        reason: "invalid_daemon_state",
      });
    }
    expect(inspectDaemonRestartState(statePath, ["--unblock-daemon"])).toMatchObject({
      allowed: true,
      unblocked: true,
      reason: "invalid_daemon_state",
    });
  });

  it("accepts only the daemon statuses emitted by specialized runtimes", () => {
    for (const status of ["running", "retrying", "stopped", "complete", "terminal_blocked"]) {
      expect(validateSpecializedDaemonState({ status })).toEqual({ status });
    }
    expect(() => validateSpecializedDaemonState({ status: "idle" })).toThrow(/status/);
  });

  it("times out and kills the complete subprocess tree", async () => {
    const grandchildPidPath = path.join(tempRoot(), "grandchild.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[1], String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const result = await spawnWithTimeout(
      process.execPath,
      ["-e", script, grandchildPidPath],
      { stdio: "ignore" },
      500,
    );
    expect(result.timedOut).toBe(true);
    expect(result.error?.code).toBe("ETIMEDOUT");
    const grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
    expect(processIsAlive(grandchildPid)).toBe(false);
  });

  it("rejects duplicate AGI literature evidence with a precise batch reason", () => {
    const workbench = tempRoot();
    const papers = path.join(workbench, "missions", AGI_MISSION_ID, "papers");
    mkdirSync(papers, { recursive: true });
    writeFileSync(path.join(papers, "batch-01.yaml"), validAgiBatch("Repeated Evidence"), "utf8");
    writeFileSync(path.join(papers, "batch-02.yaml"), validAgiBatch("Repeated Evidence"), "utf8");
    expect(validateAgiBatch(workbench, 1)).toMatchObject({ ok: true, count: 25 });
    expect(validateAgiLiteratureEvidence(workbench)).toMatchObject({
      ok: false,
      completedBatches: 1,
      reason: expect.stringMatching(/batch-02.*duplicates prior evidence/),
    });
  });

  it("rejects an empty merged book even when every chapter passes the local quality gate", () => {
    const workbench = tempRoot();
    const dir = missionDir(workbench);
    mkdirSync(path.join(dir, "chapters"), { recursive: true });
    mkdirSync(path.join(dir, "book"), { recursive: true });
    writeFileSync(path.join(dir, "axioms.md"), `# Axioms\n\nA1 world model\n${"x".repeat(100)}`, "utf8");
    writeFileSync(path.join(dir, "outline.md"), `# Outline\n\n第20章 final\n${"x".repeat(100)}`, "utf8");
    writeFileSync(path.join(dir, "quality-rubric.md"), `# 硬门禁 quality\n\n${"x".repeat(100)}`, "utf8");
    writeFileSync(
      path.join(dir, "book-meta.yaml"),
      `title: test\nchapters: 20\n${`description: ${"x".repeat(100)}`}\n`,
      "utf8",
    );
    for (let chapter = 1; chapter <= CHAPTER_COUNT; chapter += 1) {
      writeFileSync(
        path.join(dir, "chapters", `ch${String(chapter).padStart(2, "0")}.md`),
        validBookChapter(chapter),
        "utf8",
      );
    }
    writeFileSync(path.join(dir, "book", "全书.md"), "", "utf8");
    expect(validateBookCompletionEvidence(workbench)).toMatchObject({
      ok: false,
      completedChapters: CHAPTER_COUNT,
      reason: expect.stringMatching(/merged book too short/),
    });
  });

  it("treats an unknown AGI run kind as a terminal blocked slot", async () => {
    const result = await advanceOneAgiSlot(tempRoot(), {
      queueIo: {
        readNowQueueSnapshot: () => ({
          now: [{ id: "bad-kind", mission_id: AGI_MISSION_ID, phase_id: "ag00-taxonomy", run_kind: "mystery" }],
          backlog: [],
          revision: "fixture",
          source: "file",
        }),
      },
      manifest: {},
      missionProgress: {},
      idempotency: {},
    });
    expect(result).toMatchObject({
      advanced: false,
      blocked: true,
      reason: "unsupported_kind:mystery",
    });
  });

  it("makes every specialized entrypoint reject zero max-slots before doing work", async () => {
    const workbench = tempRoot();
    const scripts = [
      "run-agi-literature-daemon.mjs",
      "run-axiom-book-daemon.mjs",
      "run-agi-literature-loop.mjs",
      "run-axiom-book-loop.mjs",
      "run-book-quality-loop.mjs",
    ];
    for (const script of scripts) {
      const result = await spawnWithTimeout(
        process.execPath,
        [path.join("scripts", script), "--max-slots=0"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench },
          shell: false,
        },
        DAEMON_CHILD_TEST_TIMEOUT_MS,
      );
      expect(result.status, `${script}: ${result.stderr}`).toBe(TERMINAL_BLOCK_EXIT);
      expect(result.stderr).toMatch(/max-slots must be between/);
    }
  }, DAEMON_MULTI_PROCESS_TEST_TIMEOUT_MS);

  it.each([
    {
      script: "run-agi-literature-daemon.mjs",
      missionId: "juno-agi-literature-2026",
      stateFile: "agi-daemon.json",
      pidFile: "agi-daemon.pid",
    },
    {
      script: "run-axiom-book-daemon.mjs",
      missionId: "juno-axiom-book-2026",
      stateFile: "book-daemon.json",
      pidFile: "book-daemon.pid",
    },
  ])("blocks an invalid receipt even when $script mission checkpoint is incomplete", async (entry) => {
    const workbench = tempRoot();
    const missionPath = path.join(workbench, "missions", entry.missionId);
    mkdirSync(missionPath, { recursive: true });
    writeFileSync(path.join(missionPath, "checkpoint.md"), "STATUS: IN_PROGRESS\n", "utf8");
    const receiptPath = missionCompletionReceiptPath(workbench, entry.missionId);
    mkdirSync(path.dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, "{", "utf8");

    const result = await spawnWithTimeout(
      process.execPath,
      [path.join("scripts", entry.script), "--max-slots=1"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench },
        shell: false,
      },
      DAEMON_CHILD_TEST_TIMEOUT_MS,
    );
    expect(result.status, result.stderr).toBe(TERMINAL_BLOCK_EXIT);
    const state = JSON.parse(
      readFileSync(path.join(workbench, "state", entry.stateFile), "utf8"),
    );
    expect(state).toMatchObject({ status: "terminal_blocked", receiptState: "invalid" });
    expect(existsSync(path.join(workbench, "state", entry.pidFile))).toBe(false);
  }, DAEMON_PROCESS_TEST_TIMEOUT_MS);

  it("requires a trusted receipt even when all AGI domain evidence is valid", async () => {
    const workbench = tempRoot();
    const missionPath = path.join(workbench, "missions", AGI_MISSION_ID);
    const papersPath = path.join(missionPath, "papers");
    mkdirSync(papersPath, { recursive: true });
    writeFileSync(path.join(missionPath, "checkpoint.md"), "STATUS: COMPLETE\n", "utf8");
    for (let batch = 1; batch <= 40; batch += 1) {
      writeFileSync(
        path.join(papersPath, `batch-${String(batch).padStart(2, "0")}.yaml`),
        validAgiBatch(`Unique Batch ${batch}`),
        "utf8",
      );
    }

    const result = await spawnWithTimeout(
      process.execPath,
      [path.join("scripts", "run-agi-literature-daemon.mjs"), "--max-slots=1"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench },
        shell: false,
      },
      DAEMON_CHILD_TEST_TIMEOUT_MS,
    );
    expect(result.status, result.stderr).toBe(TERMINAL_BLOCK_EXIT);
    const state = JSON.parse(
      readFileSync(path.join(workbench, "state", "agi-daemon.json"), "utf8"),
    );
    expect(state).toMatchObject({
      status: "terminal_blocked",
      completedBatches: 40,
      artifactsReady: true,
      receiptState: "missing",
      evidenceReason: "missing trusted mission completion receipt",
    });
    expect(existsSync(path.join(workbench, "state", "agi-daemon.pid"))).toBe(false);
  }, DAEMON_PROCESS_TEST_TIMEOUT_MS);

  it.each([
    {
      script: "run-agi-literature-daemon.mjs",
      missionId: "juno-agi-literature-2026",
      pidFile: "agi-daemon.pid",
      stateFile: "agi-daemon.json",
      staleState: { status: "complete", completedBatches: 40, papersApprox: 1000 },
      expectedEvidenceState: { completedBatches: 0, papersApprox: 0 },
    },
    {
      script: "run-axiom-book-daemon.mjs",
      missionId: "juno-axiom-book-2026",
      pidFile: "book-daemon.pid",
      stateFile: "book-daemon.json",
      staleState: { status: "complete", completedChapters: 20, bookHan: 100_000 },
      expectedEvidenceState: { completedChapters: 0, bookHan: 0 },
    },
  ])("rejects fake COMPLETE evidence, preserves terminal state, and releases $script pid ownership", async (entry) => {
    const workbench = tempRoot();
    const missionDir = path.join(workbench, "missions", entry.missionId);
    const stateDir = path.join(workbench, "state");
    mkdirSync(missionDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(missionDir, "checkpoint.md"), "STATUS: COMPLETE\n", "utf8");
    writeFileSync(
      path.join(stateDir, entry.stateFile),
      `${JSON.stringify(entry.staleState, null, 2)}\n`,
      "utf8",
    );

    const result = await spawnWithTimeout(
      process.execPath,
      [path.join("scripts", entry.script)],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench },
        shell: false,
      },
      DAEMON_CHILD_TEST_TIMEOUT_MS,
    );

    expect(result.status, result.stderr).toBe(TERMINAL_BLOCK_EXIT);
    expect(existsSync(path.join(workbench, "state", entry.pidFile))).toBe(false);
    const state = JSON.parse(
      readFileSync(path.join(workbench, "state", entry.stateFile), "utf8"),
    );
    expect(state).toMatchObject({
      status: "terminal_blocked",
      blockedReason: expect.stringMatching(/^invalid_complete_checkpoint:/),
      ...entry.expectedEvidenceState,
    });

    const terminalRaw = readFileSync(path.join(workbench, "state", entry.stateFile), "utf8");
    const blockedRestart = await spawnWithTimeout(
      process.execPath,
      [path.join("scripts", entry.script)],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench },
        shell: false,
      },
      DAEMON_CHILD_TEST_TIMEOUT_MS,
    );
    expect(blockedRestart.status, blockedRestart.stderr).toBe(TERMINAL_BLOCK_EXIT);
    expect(blockedRestart.stderr).toMatch(/--unblock-daemon required/);
    expect(readFileSync(path.join(workbench, "state", entry.stateFile), "utf8")).toBe(terminalRaw);
    expect(existsSync(path.join(workbench, "state", entry.pidFile))).toBe(false);

    const explicitRestart = await spawnWithTimeout(
      process.execPath,
      [path.join("scripts", entry.script), "--unblock-daemon"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench },
        shell: false,
      },
      DAEMON_CHILD_TEST_TIMEOUT_MS,
    );
    expect(explicitRestart.status, explicitRestart.stderr).toBe(TERMINAL_BLOCK_EXIT);
    const restartedState = JSON.parse(
      readFileSync(path.join(workbench, "state", entry.stateFile), "utf8"),
    );
    expect(restartedState.unblockedAt).toEqual(expect.any(String));
    expect(restartedState.blockedReason).toMatch(/^invalid_complete_checkpoint:/);
  }, DAEMON_RESTART_TEST_TIMEOUT_MS);
});
