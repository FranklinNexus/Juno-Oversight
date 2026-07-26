import { describe, expect, it } from "vitest";
import {
  decideNextAction,
  recordAutonomyDecision,
  readAutonomyState,
  reserveAutonomyDecision,
  settleAutonomyDecision,
  DEFAULT_AUTONOMY_LIMITS,
} from "../../../orchestrator/src/bounded-autonomy.js";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeTrustedCompletionReceiptFixture } from "./completion-receipt.test-helper.js";

function completeMission(workbench: string, missionId: string): void {
  mkdirSync(path.join(workbench, "missions", missionId), { recursive: true });
  writeTrustedCompletionReceiptFixture(workbench, missionId);
}

function wb(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "juno-autonomy-"));
  mkdirSync(path.join(dir, "missions", "juno-self-iterate-p2-2026"), { recursive: true });
  writeFileSync(
    path.join(dir, "missions", "juno-self-iterate-p2-2026", "progress.md"),
    "| p01 | implement | in_progress |\n",
    "utf8",
  );
  mkdirSync(path.join(dir, "state"), { recursive: true });
  writeFileSync(path.join(dir, "config.yaml"), "scheduler:\n  require_loop_gate: false\n", "utf8");
  return dir;
}

describe("bounded-autonomy", () => {
  it("suggests P2 loop when P2 incomplete", () => {
    const d = decideNextAction(wb(), DEFAULT_AUTONOMY_LIMITS);
    expect(d.action).toBe("run_local_loop");
    if (d.action !== "run_local_loop") throw new Error(`unexpected action: ${d.action}`);
    expect(d.missionId).toBe("juno-self-iterate-p2-2026");
  });

  it("suggests axiom book when AGI complete and book not started", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-autonomy-agi-"));
    mkdirSync(path.join(dir, "missions", "juno-self-iterate-p2-2026"), { recursive: true });
    mkdirSync(path.join(dir, "missions", "juno-agi-literature-2026"), { recursive: true });
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(path.join(dir, "config.yaml"), "scheduler:\n  require_loop_gate: false\n", "utf8");
    completeMission(dir, "juno-self-iterate-p2-2026");
    completeMission(dir, "juno-agi-literature-2026");
    const d = decideNextAction(dir, DEFAULT_AUTONOMY_LIMITS);
    expect(d.action).toBe("queue_mission");
    if (d.action !== "queue_mission") throw new Error(`unexpected action: ${d.action}`);
    expect(d.missionId).toBe("juno-axiom-book-2026");
  });

  it("escalates at daily iteration cap", () => {
    const dir = wb();
    writeFileSync(
      path.join(dir, "state", "bounded-autonomy.json"),
      JSON.stringify({
        date: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }),
        iterationsToday: 99,
        autoQueuedToday: 0,
      }),
      "utf8",
    );
    const d = decideNextAction(dir, { ...DEFAULT_AUTONOMY_LIMITS, maxSelfIterationsPerDay: 3 });
    expect(d.action).toBe("escalate_human");
  });

  it("does not increment iteration when recordAutonomyDecision succeeded=false", () => {
    const dir = wb();
    mkdirSync(path.join(dir, "config"), { recursive: true });
    writeFileSync(
      path.join(dir, "config", "daily-schedule.json"),
      JSON.stringify({ autonomyTimezone: "Asia/Shanghai" }),
      "utf8",
    );
    const before = readAutonomyState(dir).iterationsToday;
    recordAutonomyDecision(
      dir,
      {
        action: "run_book_quality_loop",
        missionId: "juno-book-quality-2026",
        script: "book:quality-loop",
        reason: "test fail",
      },
      { succeeded: false },
    );
    expect(readAutonomyState(dir).iterationsToday).toBe(before);
  });

  it("rechecks the daily cap inside the legacy record mutation", () => {
    const dir = wb();
    const decision = {
      action: "run_local_loop" as const,
      missionId: "juno-self-iterate-p2-2026",
      script: "loop:self-iterate-p2-run",
      reason: "legacy concurrency guard",
    };
    writeFileSync(
      path.join(dir, "state", "bounded-autonomy.json"),
      JSON.stringify({
        date: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }),
        iterationsToday: DEFAULT_AUTONOMY_LIMITS.maxSelfIterationsPerDay - 1,
        autoQueuedToday: 0,
      }),
      "utf8",
    );

    recordAutonomyDecision(dir, decision);
    expect(() => recordAutonomyDecision(dir, decision)).toThrow(/iteration cap/i);
    expect(readAutonomyState(dir).iterationsToday).toBe(
      DEFAULT_AUTONOMY_LIMITS.maxSelfIterationsPerDay,
    );
  });

  it("reserves an iteration before execution and never refunds a failed outcome", () => {
    const dir = wb();
    const decision = {
      action: "run_local_loop" as const,
      missionId: "juno-self-iterate-p2-2026",
      script: "loop:self-iterate-p2-run",
      reason: "reservation test",
    };

    const reservation = reserveAutonomyDecision(dir, decision, {
      ...DEFAULT_AUTONOMY_LIMITS,
      maxSelfIterationsPerDay: 1,
    });
    expect(reservation.state.iterationsToday).toBe(1);
    const reserved = JSON.parse(
      readFileSync(path.join(dir, "state", "bounded-autonomy.json"), "utf8"),
    );
    expect(reserved.activeReservation).toMatchObject({
      actionId: reservation.actionId,
      outcome: "reserved",
    });

    settleAutonomyDecision(dir, reservation.actionId, decision, {
      succeeded: false,
      detail: "synthetic failure",
    });
    const settled = JSON.parse(
      readFileSync(path.join(dir, "state", "bounded-autonomy.json"), "utf8"),
    );
    expect(settled.iterationsToday).toBe(1);
    expect(settled.activeReservation).toBeUndefined();
    expect(settled.lastReservation).toMatchObject({
      actionId: reservation.actionId,
      outcome: "failed",
      detail: "synthetic failure",
    });
  });

  it("recovers a crashed reservation without refunding its count", () => {
    const dir = wb();
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    writeFileSync(
      path.join(dir, "state", "bounded-autonomy.json"),
      JSON.stringify({
        date: today,
        iterationsToday: 1,
        autoQueuedToday: 0,
        activeReservation: {
          actionId: "crashed-action-0001",
          action: "run_local_loop",
          missionId: "juno-self-iterate-p2-2026",
          ownerPid: 2_000_000_000,
          reservedAt: new Date(Date.now() - 60_000).toISOString(),
          outcome: "reserved",
        },
      }),
      "utf8",
    );
    const decision = {
      action: "run_local_loop" as const,
      missionId: "juno-self-iterate-p2-2026",
      script: "loop:self-iterate-p2-run",
      reason: "crash recovery test",
    };

    expect(() =>
      reserveAutonomyDecision(dir, decision, {
        ...DEFAULT_AUTONOMY_LIMITS,
        maxSelfIterationsPerDay: 1,
      }),
    ).toThrow(/iteration cap/i);
    const recovered = JSON.parse(
      readFileSync(path.join(dir, "state", "bounded-autonomy.json"), "utf8"),
    );
    expect(recovered.iterationsToday).toBe(1);
    expect(recovered.activeReservation).toBeUndefined();
    expect(recovered.lastReservation).toMatchObject({
      actionId: "crashed-action-0001",
      outcome: "interrupted",
    });
  });

  it("recovers a stale state lock owned by a dead process", () => {
    const dir = wb();
    const lockPath = path.join(dir, "state", "bounded-autonomy.lock.json");
    writeFileSync(
      lockPath,
      JSON.stringify({
        token: "stale-state-lock",
        pid: 2_000_000_000,
        acquiredAt: Date.now() - 60_000,
      }),
      "utf8",
    );
    const decision = {
      action: "run_local_loop" as const,
      missionId: "juno-self-iterate-p2-2026",
      script: "loop:self-iterate-p2-run",
      reason: "stale lock recovery",
    };

    const reservation = reserveAutonomyDecision(dir, decision);
    expect(reservation.state.iterationsToday).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
    settleAutonomyDecision(dir, reservation.actionId, decision, { succeeded: false });
    expect(readAutonomyState(dir).iterationsToday).toBe(1);
  });

  it("serializes concurrent reservations so the daily cap cannot be oversubscribed", () => {
    const dir = wb();
    const decision = {
      action: "run_local_loop" as const,
      missionId: "juno-self-iterate-p2-2026",
      script: "loop:self-iterate-p2-run",
      reason: "concurrency test",
    };
    const limits = { ...DEFAULT_AUTONOMY_LIMITS, maxSelfIterationsPerDay: 1 };
    const first = reserveAutonomyDecision(dir, decision, limits);
    expect(() => reserveAutonomyDecision(dir, decision, limits)).toThrow(/already reserved/i);
    settleAutonomyDecision(dir, first.actionId, decision, { succeeded: true });
    expect(() => reserveAutonomyDecision(dir, decision, limits)).toThrow(/iteration cap/i);
    expect(readAutonomyState(dir).iterationsToday).toBe(1);
  });

  it("fails closed instead of resetting a corrupt or future-dated autonomy state", () => {
    const corrupt = wb();
    writeFileSync(path.join(corrupt, "state", "bounded-autonomy.json"), "{broken", "utf8");
    expect(() => readAutonomyState(corrupt)).toThrow(/refusing to reset daily limits/i);

    const future = wb();
    writeFileSync(
      path.join(future, "state", "bounded-autonomy.json"),
      JSON.stringify({ date: "2999-01-01", iterationsToday: 0, autoQueuedToday: 0 }),
      "utf8",
    );
    expect(() => readAutonomyState(future)).toThrow(/future/i);
  });
});
