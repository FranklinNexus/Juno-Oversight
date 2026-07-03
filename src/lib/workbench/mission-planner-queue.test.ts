import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_AUTONOMY_LIMITS } from "../../../orchestrator/src/autonomy-types.js";
import { planNextMission, sanitizeAutonomyQueue } from "../../../orchestrator/src/mission-planner.js";
import { parseNowYaml } from "../../../orchestrator/src/queue-io.js";

describe("mission-planner queue head", () => {
  it("sanitizes disallowed queue missions to backlog", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-planner-q-"));
    mkdirSync(path.join(dir, "queue"), { recursive: true });
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(
      path.join(dir, "queue", "now.yaml"),
      "now:\n  - id: site-1\n    mission_id: landing-site-2026\nbacklog: []\n",
      "utf8",
    );
    writeFileSync(path.join(dir, "config.yaml"), "scheduler:\n  require_loop_gate: false\n", "utf8");

    const moved = sanitizeAutonomyQueue(dir, DEFAULT_AUTONOMY_LIMITS.allowedMissionIds);
    expect(moved.changed).toBe(true);
    expect(moved.moved).toContain("landing-site-2026");
    const { now, backlog } = parseNowYaml(dir);
    expect(now).toHaveLength(0);
    expect(backlog.some((i) => i.mission_id === "landing-site-2026")).toBe(true);

    const d = planNextMission({
      workbench: dir,
      state: { date: "2026-07-03", iterationsToday: 0, autoQueuedToday: 0 },
      limits: DEFAULT_AUTONOMY_LIMITS,
    });
    expect(String(d.reason ?? "")).not.toContain("allowedMissionIds");
  });

  it("uses queue head mission_id not first match in file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-planner-qhead-"));
    mkdirSync(path.join(dir, "queue"), { recursive: true });
    writeFileSync(
      path.join(dir, "queue", "now.yaml"),
      [
        "now:",
        "  - id: jupiter-bench-001",
        "    kind: jinstone",
        "  - id: site-2",
        "    mission_id: landing-site-2026",
        "backlog: []",
      ].join("\n"),
      "utf8",
    );
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(path.join(dir, "config.yaml"), "scheduler:\n  require_loop_gate: false\n", "utf8");

    const d = planNextMission({
      workbench: dir,
      state: { date: "2026-07-03", iterationsToday: 0, autoQueuedToday: 0 },
      limits: DEFAULT_AUTONOMY_LIMITS,
    });
    expect(String(d.reason ?? "")).not.toContain("landing-site-2026");
  });
});
