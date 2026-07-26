import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  checkpointTextForAdvance,
  finalizeRunCheckpoint,
  isRunCheckpointStub,
  resolveQueueAdvance,
} from "../../../orchestrator/src/mission-progress.js";

describe("isRunCheckpointStub", () => {
  it("requires an exact, unique COMPLETE status line", () => {
    expect(isRunCheckpointStub("notes: STATUS: COMPLETE\n")).toBe(true);
    expect(isRunCheckpointStub("STATUS: COMPLETE-ish\n")).toBe(true);
    expect(isRunCheckpointStub("STATUS: COMPLETE\nSTATUS: BLOCKED\n")).toBe(true);
    expect(isRunCheckpointStub("STATUS: COMPLETE\n")).toBe(false);
  });
});

describe("finalizeRunCheckpoint", () => {
  it("does not let a mission checkpoint satisfy a new run", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-mcp-mirror-"));
    const missionId = "juno-workbench-cleanup-2026";
    const runId = "juno-c02-execute";
    mkdirSync(path.join(dir, "missions", missionId), { recursive: true });
    mkdirSync(path.join(dir, "runs", runId), { recursive: true });

    writeFileSync(
      path.join(dir, "runs", runId, "checkpoint.md"),
      "# Checkpoint\n\n## 目标\n（待 Agent 填写）\n\n## 进度\n- [ ] slot 0\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "missions", missionId, "checkpoint.md"),
      "# Mission cp\n\nSTATUS: COMPLETE\n\n## CHANGES\n- purge-report.json\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "runs", runId, "manifest.json"),
      JSON.stringify({ runKind: "implement" }),
      "utf8",
    );

    const originalRunCheckpoint = readFileSync(
      path.join(dir, "runs", runId, "checkpoint.md"),
      "utf8",
    );
    expect(finalizeRunCheckpoint(dir, runId, missionId, "implement")).toBe(false);

    const runCp = readFileSync(path.join(dir, "runs", runId, "checkpoint.md"), "utf8");
    expect(runCp).toBe(originalRunCheckpoint);
    expect(runCp).not.toMatch(/## CHANGES/);
    expect(runCp).not.toMatch(/STATUS:\s*COMPLETE/i);

    const advance = resolveQueueAdvance("implement", checkpointTextForAdvance(dir, runId, missionId));
    expect(advance).toEqual({ action: "hold", reason: "review_pending" });
  });

  it("does not mirror when run checkpoint already has gate markers", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-mcp-skip-"));
    const missionId = "juno-workbench-cleanup-2026";
    const runId = "juno-c02-execute";
    mkdirSync(path.join(dir, "missions", missionId), { recursive: true });
    mkdirSync(path.join(dir, "runs", runId), { recursive: true });

    writeFileSync(
      path.join(dir, "runs", runId, "checkpoint.md"),
      "STATUS: COMPLETE\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "missions", missionId, "checkpoint.md"),
      "## CHANGES\n- x\n",
      "utf8",
    );

    expect(finalizeRunCheckpoint(dir, runId, missionId, "implement")).toBe(false);
  });
});
