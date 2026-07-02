import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_AUTONOMY_LIMITS } from "../../../orchestrator/src/autonomy-types.js";
import { planNextMission } from "../../../orchestrator/src/mission-planner.js";

function wb(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "juno-planner-"));
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

describe("mission-planner", () => {
  it("continues P2 when incomplete", () => {
    const d = planNextMission({
      workbench: wb(),
      state: { date: "2026-07-03", iterationsToday: 0, autoQueuedToday: 0 },
      limits: DEFAULT_AUTONOMY_LIMITS,
    });
    expect(d.action).toBe("run_local_loop");
  });

  it("continues hardening when upstream complete and h07 queued", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-planner-h-"));
    for (const id of ["juno-self-iterate-p2-2026", "juno-agi-literature-2026", "juno-axiom-book-2026"]) {
      mkdirSync(path.join(dir, "missions", id), { recursive: true });
      writeFileSync(path.join(dir, "missions", id, "checkpoint.md"), "STATUS: COMPLETE\n", "utf8");
    }
    mkdirSync(path.join(dir, "missions", "juno-overseer-hardening-2026"), { recursive: true });
    writeFileSync(
      path.join(dir, "missions", "juno-overseer-hardening-2026", "progress.md"),
      "| h07 | implement | queued |\n",
      "utf8",
    );
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(
      path.join(dir, "state", "self-optimize.json"),
      `${JSON.stringify({ ranAt: new Date().toISOString(), rubricPatched: false, mcpHintsWritten: false, recommendedActions: [] })}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(dir, "state", "quality-scan.json"),
      `${JSON.stringify({ scannedAt: new Date().toISOString(), failedChapters: [] })}\n`,
      "utf8",
    );
    writeFileSync(path.join(dir, "config.yaml"), "scheduler:\n  require_loop_gate: false\n", "utf8");

    const d = planNextMission({
      workbench: dir,
      state: { date: "2026-07-03", iterationsToday: 0, autoQueuedToday: 0 },
      limits: DEFAULT_AUTONOMY_LIMITS,
    });
    expect(["run_generic_loop", "queue_mission"]).toContain(d.action);
    if (d.action === "run_generic_loop" || d.action === "queue_mission") {
      expect(d.missionId).toBe("juno-overseer-hardening-2026");
    }
  });
});
