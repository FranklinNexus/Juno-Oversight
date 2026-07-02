import { describe, expect, it } from "vitest";
import {
  decideNextAction,
  recordAutonomyDecision,
  readAutonomyState,
  DEFAULT_AUTONOMY_LIMITS,
} from "../../../orchestrator/src/bounded-autonomy.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

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
    expect(d.missionId).toBe("juno-self-iterate-p2-2026");
  });

  it("suggests axiom book when AGI complete and book not started", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-autonomy-agi-"));
    mkdirSync(path.join(dir, "missions", "juno-self-iterate-p2-2026"), { recursive: true });
    mkdirSync(path.join(dir, "missions", "juno-agi-literature-2026"), { recursive: true });
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(path.join(dir, "config.yaml"), "scheduler:\n  require_loop_gate: false\n", "utf8");
    writeFileSync(
      path.join(dir, "missions", "juno-self-iterate-p2-2026", "checkpoint.md"),
      "STATUS: COMPLETE\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "missions", "juno-agi-literature-2026", "checkpoint.md"),
      "STATUS: COMPLETE\n",
      "utf8",
    );
    const d = decideNextAction(dir, DEFAULT_AUTONOMY_LIMITS);
    expect(d.action).toBe("queue_mission");
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
});
