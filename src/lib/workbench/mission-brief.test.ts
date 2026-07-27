import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileBriefFromText,
  inferSchedule,
  inferTags,
  routeBriefToKnownMission,
  writeBriefMission,
} from "../../../orchestrator/src/mission-brief.js";
import { detectMcpNeeds } from "../../../orchestrator/src/mcp-provision.js";

describe("mission-brief", () => {
  it("infers daily schedule", () => {
    expect(inferSchedule("每天 inbox 给我三件事")).toBe("daily");
    expect(inferSchedule("fix blog once")).toBe("once");
  });

  it("tags hardware and push", () => {
    const tags = inferTags("开发板 serial MCP push");
    expect(tags).toContain("hardware-mcp");
    expect(tags).toContain("auto-push");
  });

  it("routes wisdomechoes brief", () => {
    expect(routeBriefToKnownMission("wisdomechoes 两篇 AI 合并")).toBe(
      "juno-wisdomechoes-axiom-blog-2026",
    );
  });

  it("compiles generic mission with phases", () => {
    const plan = compileBriefFromText("Add logging to dev-smoke");
    expect(plan.phases.length).toBeGreaterThanOrEqual(4);
    expect(plan.missionId).toMatch(/^juno-brief-/);
  });

  it("writes a visible mission and preserves an active queue", () => {
    const workbench = mkdtempSync(path.join(tmpdir(), "juno-brief-"));
    try {
      mkdirSync(path.join(workbench, "queue"), { recursive: true });
      writeFileSync(
        path.join(workbench, "queue", "now.yaml"),
        "updated: now\nnow:\n  - id: current-task\n    horizon: day\n    kind: implement\n    prompt: executor_implement\nbacklog:\n  []\n",
        "utf8",
      );
      const plan = compileBriefFromText("Ship a simpler product flow", {
        missionId: "juno-brief-visible-test",
      });

      const missionDir = writeBriefMission(workbench, plan);
      const queue = readFileSync(path.join(workbench, "queue", "now.yaml"), "utf8");

      expect(existsSync(path.join(missionDir, "mission.yaml"))).toBe(true);
      expect(readFileSync(path.join(missionDir, "mission.yaml"), "utf8")).toContain(
        'title: "Ship a simpler product flow"',
      );
      expect(queue).toContain("id: current-task");
      expect(queue).toContain("juno-brief-visible-test-p01-plan");
      expect(queue.indexOf("current-task")).toBeLessThan(queue.indexOf("juno-brief-visible-test"));
    } finally {
      rmSync(workbench, { recursive: true, force: true });
    }
  });
});

describe("mcp-provision", () => {
  it("detects serial board need", () => {
    const needs = detectMcpNeeds("电脑接了两块开发板");
    expect(needs.some((n) => n.id === "serial-boards")).toBe(true);
  });
});
