import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_AUTONOMY_LIMITS } from "../../../orchestrator/src/autonomy-types.js";
import { planNextMission } from "../../../orchestrator/src/mission-planner.js";

describe("mission-planner queue head", () => {
  it("stops when queue head mission not in allowedMissionIds", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-planner-q-"));
    mkdirSync(path.join(dir, "queue"), { recursive: true });
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(
      path.join(dir, "queue", "now.yaml"),
      "now:\n  - mission_id: landing-site-2026\n",
      "utf8",
    );
    writeFileSync(path.join(dir, "config.yaml"), "scheduler:\n  require_loop_gate: false\n", "utf8");

    const d = planNextMission({
      workbench: dir,
      state: { date: "2026-07-03", iterationsToday: 0, autoQueuedToday: 0 },
      limits: DEFAULT_AUTONOMY_LIMITS,
    });
    expect(d.action).toBe("stop");
    expect(d.reason).toContain("allowedMissionIds");
  });
});
