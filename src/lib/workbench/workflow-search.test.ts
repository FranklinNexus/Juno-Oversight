import { describe, expect, it } from "vitest";
import {
  scoreWorkflow,
  selectBestWorkflow,
  workflowSignalsFromRuns,
  readActiveWorkflowSelection,
} from "../../../orchestrator/src/workflow-search.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("workflow-search", () => {
  it("scores default workflow higher with passing signals", () => {
    const base = scoreWorkflow("default", {});
    const boosted = scoreWorkflow("default", {
      testsPass: true,
      verifyPass: true,
      safetyPass: true,
    });
    expect(boosted.score).toBeGreaterThan(base.score);
  });

  it("selects best among variants", () => {
    const best = selectBestWorkflow(["default", "self-iterate-p2"], {
      testsPass: true,
      verifyPass: true,
    });
    expect(best.workflowId).toBeTruthy();
    expect(best.score).toBeGreaterThan(0);
  });

  it("scores real workflow run evidence and never invents PASS", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-workflow-evidence-"));
    const runDir = path.join(workbench, "runs", "verify-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, "manifest.json"),
      JSON.stringify({ workflowId: "default", runKind: "verify" }),
      "utf8",
    );
    writeFileSync(path.join(runDir, "run-state.json"), JSON.stringify({ lastStatus: "failed" }), "utf8");
    writeFileSync(path.join(runDir, "checkpoint.md"), "## VERIFY_REPORT\n- tests: FAIL\n", "utf8");
    const signals = workflowSignalsFromRuns(workbench, "default");
    expect(signals.sampleSize).toBe(1);
    expect(signals.failureCount).toBe(1);
    expect(signals.verifyFailCount).toBe(1);
    expect(signals.verifyPassCount).toBe(0);
  });

  it("treats transport done without gate evidence as a failed outcome", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-workflow-incomplete-"));
    const runDir = path.join(workbench, "runs", "implement-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, "manifest.json"),
      JSON.stringify({ workflowId: "default", runKind: "implement" }),
      "utf8",
    );
    writeFileSync(path.join(runDir, "run-state.json"), JSON.stringify({ lastStatus: "done" }), "utf8");
    writeFileSync(path.join(runDir, "checkpoint.md"), "STATUS: COMPLETE\n", "utf8");

    const signals = workflowSignalsFromRuns(workbench, "default");
    expect(signals.sampleSize).toBe(1);
    expect(signals.successCount).toBe(0);
    expect(signals.failureCount).toBe(1);
  });

  it("returns undefined only for a missing selection and fails closed on present legacy state", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-workflow-active-"));
    mkdirSync(path.join(workbench, "state"), { recursive: true });
    expect(readActiveWorkflowSelection(workbench, "mission-a")).toBeUndefined();
    writeFileSync(
      path.join(workbench, "state", "workflow-selection.json"),
      JSON.stringify({ workflowId: "default", missionId: "mission-a", active: true }),
      "utf8",
    );
    expect(() => readActiveWorkflowSelection(workbench, "mission-a"))
      .toThrow(/present but invalid or untrusted/i);
    expect(() => readActiveWorkflowSelection(workbench, "mission-b"))
      .toThrow(/present but invalid or untrusted/i);
  });
});
