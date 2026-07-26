import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_AUTONOMY_LIMITS } from "../../../orchestrator/src/autonomy-types.js";
import { writeTrustedCompletionReceiptFixture } from "./completion-receipt.test-helper.js";
import {
  decisionForSpec,
  DEFAULT_MISSION_REGISTRY,
  loadAutonomyCharter,
  loadMissionRegistry,
  loadRuntimeScriptRegistry,
  missionComplete,
  planNextMission,
  PLANNER_ARBITRATION_POLICY,
} from "../../../orchestrator/src/mission-planner.js";

function completeMission(workbench: string, missionId: string): void {
  mkdirSync(path.join(workbench, "missions", missionId), { recursive: true });
  writeTrustedCompletionReceiptFixture(workbench, missionId);
}

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
  it("documents arbitration order before drive proposals", () => {
    expect(PLANNER_ARBITRATION_POLICY.indexOf("explicit_queue_head")).toBeLessThan(
      PLANNER_ARBITRATION_POLICY.indexOf("drive_proposal"),
    );
    expect(PLANNER_ARBITRATION_POLICY.indexOf("incomplete_registry_mission")).toBeLessThan(
      PLANNER_ARBITRATION_POLICY.indexOf("drive_proposal"),
    );
  });

  it("does not trust a mission checkpoint and requires a control-plane receipt", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-planner-done-"));
    const missionDir = path.join(dir, "missions", "mission-done");
    mkdirSync(missionDir, { recursive: true });
    writeFileSync(
      path.join(missionDir, "progress.md"),
      "| phase | kind | status |\n|---|---|---|\n| p01 | implement | done |\n| p02 | verify | complete |\n",
      "utf8",
    );
    expect(missionComplete(dir, "mission-done")).toBe(false);

    writeFileSync(path.join(missionDir, "checkpoint.md"), "STATUS: COMPLETE\n", "utf8");
    expect(missionComplete(dir, "mission-done")).toBe(false);
    completeMission(dir, "mission-done");
    expect(missionComplete(dir, "mission-done")).toBe(true);
  });

  it("fails closed on unknown progress states and lets checkpoint status be authoritative", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-planner-blocked-"));
    const missionDir = path.join(dir, "missions", "mission-blocked");
    mkdirSync(missionDir, { recursive: true });
    writeFileSync(
      path.join(missionDir, "progress.md"),
      "| Phase | Status |\n|---|---|\n| p01 | done |\n| p02 | BLOCKED |\n",
      "utf8",
    );
    expect(missionComplete(dir, "mission-blocked")).toBe(false);

    writeFileSync(
      path.join(missionDir, "progress.md"),
      "| Phase | Status |\n|---|---|\n| p01 | done |\n| p02 | complete |\n",
      "utf8",
    );
    writeFileSync(path.join(missionDir, "checkpoint.md"), "STATUS: BLOCKED\n", "utf8");
    expect(missionComplete(dir, "mission-blocked")).toBe(false);

    writeFileSync(
      path.join(missionDir, "checkpoint.md"),
      "STATUS: COMPLETE\nSTATUS: BLOCKED\n",
      "utf8",
    );
    expect(missionComplete(dir, "mission-blocked")).toBe(false);
  });

  it("continues P2 when incomplete", () => {
    const d = planNextMission({
      workbench: wb(),
      state: { date: "2026-07-03", iterationsToday: 0, autoQueuedToday: 0 },
      limits: DEFAULT_AUTONOMY_LIMITS,
    });
    expect(d.action).toBe("run_local_loop");
  });

  it("fails closed when a packaged runtime cannot execute a planned loop script", () => {
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "juno-runtime-scripts-"));
    writeFileSync(
      path.join(runtimeRoot, "package.json"),
      `${JSON.stringify({ scripts: { "mission:loop": "node scripts/run-mission-loop.mjs" } })}\n`,
      "utf8",
    );
    const scripts = loadRuntimeScriptRegistry(runtimeRoot);
    const p2 = DEFAULT_MISSION_REGISTRY.find(
      (mission) => mission.missionId === "juno-self-iterate-p2-2026",
    );
    expect(p2).toBeDefined();
    expect(decisionForSpec(p2!, "continue P2", scripts)).toEqual({
      action: "escalate_human",
      reason: "runtime_script_unavailable",
      detail:
        "juno-self-iterate-p2-2026 requires unavailable runtime script loop:self-iterate-p2-run",
    });
  });

  it("does not execute a charter-forbidden queue head through the generic fallback", () => {
    const dir = wb();
    mkdirSync(path.join(dir, "config"), { recursive: true });
    writeFileSync(
      path.join(dir, "config", "autonomy-charter.json"),
      JSON.stringify({ forbiddenMissionIds: ["juno-overseer-hardening-2026"] }),
      "utf8",
    );
    mkdirSync(path.join(dir, "queue"), { recursive: true });
    writeFileSync(
      path.join(dir, "queue", "now.yaml"),
      [
        "now:",
        "  - id: forbidden-head",
        "    horizon: mission",
        "    kind: implement",
        "    mission_id: juno-overseer-hardening-2026",
        "    prompt: executor_implement",
        "backlog:",
        "  []",
        "",
      ].join("\n"),
      "utf8",
    );

    const decision = planNextMission({
      workbench: dir,
      state: { date: "2026-07-03", iterationsToday: 0, autoQueuedToday: 0 },
      limits: DEFAULT_AUTONOMY_LIMITS,
    });
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("not eligible");
  });

  it("does not execute a queue head before its required mission is complete", () => {
    const dir = wb();
    mkdirSync(path.join(dir, "queue"), { recursive: true });
    writeFileSync(
      path.join(dir, "queue", "now.yaml"),
      [
        "now:",
        "  - id: dependency-head",
        "    horizon: mission",
        "    kind: implement",
        "    mission_id: juno-agi-literature-2026",
        "    prompt: executor_implement",
        "backlog:",
        "  []",
        "",
      ].join("\n"),
      "utf8",
    );

    const decision = planNextMission({
      workbench: dir,
      state: { date: "2026-07-03", iterationsToday: 0, autoQueuedToday: 0 },
      limits: DEFAULT_AUTONOMY_LIMITS,
    });
    expect(decision.action).toBe("stop");
    expect(decision.reason).toContain("not eligible");
  });

  it("continues hardening when upstream complete and h07 queued", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-planner-h-"));
    for (const id of ["juno-self-iterate-p2-2026", "juno-agi-literature-2026", "juno-axiom-book-2026"]) {
      completeMission(dir, id);
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

  it("restores hardening queue when phases queued but now empty", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-planner-restore-"));
    for (const id of ["juno-self-iterate-p2-2026", "juno-agi-literature-2026", "juno-axiom-book-2026"]) {
      completeMission(dir, id);
    }
    mkdirSync(path.join(dir, "missions", "juno-overseer-hardening-2026"), { recursive: true });
    writeFileSync(
      path.join(dir, "missions", "juno-overseer-hardening-2026", "progress.md"),
      "| h07-promote-preview | implement | queued |\n",
      "utf8",
    );
    mkdirSync(path.join(dir, "queue"), { recursive: true });
    writeFileSync(path.join(dir, "queue", "now.yaml"), "now: []\nbacklog: []\n", "utf8");
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
    expect(d.action).toBe("queue_mission");
    if (d.action !== "queue_mission") throw new Error(`unexpected action: ${d.action}`);
    expect(d.missionId).toBe("juno-overseer-hardening-2026");
    expect(d.bootstrap).toBe("queue:hardening");
  });

  it("skips book-quality when scan PASS and picks hardening", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-planner-bq-"));
    for (const id of [
      "juno-self-iterate-p2-2026",
      "juno-agi-literature-2026",
      "juno-axiom-book-2026",
    ]) {
      completeMission(dir, id);
    }
    mkdirSync(path.join(dir, "missions", "juno-book-quality-2026"), { recursive: true });
    writeFileSync(
      path.join(dir, "missions", "juno-book-quality-2026", "progress.md"),
      "| ch16 | queued |\n",
      "utf8",
    );
    mkdirSync(path.join(dir, "missions", "juno-overseer-hardening-2026"), { recursive: true });
    writeFileSync(
      path.join(dir, "missions", "juno-overseer-hardening-2026", "progress.md"),
      "| h07-promote-preview | implement | queued |\n",
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
    mkdirSync(path.join(dir, "config"), { recursive: true });
    writeFileSync(
      path.join(dir, "config", "autonomy-charter.json"),
      `${JSON.stringify({
        missionPriority: [
          "juno-book-quality-2026",
          "juno-overseer-hardening-2026",
        ],
      })}\n`,
      "utf8",
    );

    const d = planNextMission({
      workbench: dir,
      state: { date: "2026-07-03", iterationsToday: 0, autoQueuedToday: 0 },
      limits: DEFAULT_AUTONOMY_LIMITS,
    });
    expect(["queue_mission", "run_generic_loop"]).toContain(d.action);
    if (!("missionId" in d)) throw new Error(`action has no missionId: ${d.action}`);
    expect(d.missionId).toBe("juno-overseer-hardening-2026");
    const maintenanceCheckpoint = path.join(
      dir,
      "missions",
      "juno-book-quality-2026",
      "checkpoint.md",
    );
    expect(existsSync(maintenanceCheckpoint)).toBe(true);
    expect(readFileSync(maintenanceCheckpoint, "utf8")).toContain("STATUS: MAINTENANCE_PASS");
    expect(missionComplete(dir, "juno-book-quality-2026")).toBe(false);
  });

  it("auto-discover von-neumann uses evolution:tick not mission:loop", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-planner-vn-"));
    mkdirSync(path.join(dir, "missions", "juno-von-neumann-unit-2026"), { recursive: true });
    writeFileSync(
      path.join(dir, "missions", "juno-von-neumann-unit-2026", "progress.md"),
      "| mcp-effectors | queued |\n",
      "utf8",
    );
    mkdirSync(path.join(dir, "queue"), { recursive: true });
    writeFileSync(path.join(dir, "queue", "now.yaml"), "now: []\nbacklog: []\n", "utf8");
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(path.join(dir, "config.yaml"), "scheduler:\n  require_loop_gate: false\n", "utf8");

    const d = planNextMission({
      workbench: dir,
      state: { date: "2026-07-03", iterationsToday: 0, autoQueuedToday: 0 },
      limits: DEFAULT_AUTONOMY_LIMITS,
    });
    expect(d.action).toBe("run_generic_loop");
    if (d.action !== "run_generic_loop") throw new Error(`unexpected action: ${d.action}`);
    expect(d.missionId).toBe("juno-von-neumann-unit-2026");
    expect(d.script).toBe("evolution:tick");
  });

  it("fails closed when autonomy governance files are present but malformed", () => {
    const dir = wb();
    mkdirSync(path.join(dir, "config"), { recursive: true });
    writeFileSync(path.join(dir, "config", "autonomy-charter.json"), "{broken", "utf8");
    expect(() => loadAutonomyCharter(dir)).toThrow(/refusing autonomous work/i);

    writeFileSync(
      path.join(dir, "config", "autonomy-charter.json"),
      JSON.stringify({ enabled: true }),
      "utf8",
    );
    writeFileSync(
      path.join(dir, "config", "mission-registry.json"),
      JSON.stringify({ missions: [{ missionId: "unsafe" }] }),
      "utf8",
    );
    expect(() => loadMissionRegistry(dir)).toThrow(/invalid or duplicate/i);
  });
});
