import { describe, expect, it } from "vitest";
import {
  compileBriefFromText,
  inferSchedule,
  inferTags,
  routeBriefToKnownMission,
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
});

describe("mcp-provision", () => {
  it("detects serial board need", () => {
    const needs = detectMcpNeeds("电脑接了两块开发板");
    expect(needs.some((n) => n.id === "serial-boards")).toBe(true);
  });
});
