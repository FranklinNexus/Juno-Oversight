import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSelfOptimizeConfig,
  runSelfOptimize,
} from "../../../orchestrator/src/self-optimize.js";

const AXIOM_PROMPTS = [
  "executor_implement",
  "executor_book_review",
  "executor_book_write",
  "executor_verify",
] as const;

function scaffoldAxiomPrompts(workbench: string): void {
  const promptRoot = path.join(workbench, "prompts");
  mkdirSync(promptRoot, { recursive: true });
  for (const prompt of AXIOM_PROMPTS) {
    writeFileSync(
      path.join(promptRoot, `${prompt}.md`),
      `# ${prompt}\n\nDeterministic self-optimize test prompt.\n`,
      "utf8",
    );
  }
}

describe("self-optimize config", () => {
  it("binds the resolved auto-queue decision into disabled reports", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-self-optimize-disabled-"));
    mkdirSync(path.join(workbench, "config"), { recursive: true });
    const configPath = path.join(workbench, "config", "self-optimize.json");

    writeFileSync(
      configPath,
      JSON.stringify({ enabled: false, autoQueueBookRevise: false }),
      "utf8",
    );
    expect(runSelfOptimize(workbench)).toMatchObject({
      autoQueueBookRevise: false,
      recommendedActions: ["self-optimize disabled in config"],
    });

    writeFileSync(configPath, JSON.stringify({ enabled: false }), "utf8");
    expect(runSelfOptimize(workbench).autoQueueBookRevise).toBe(true);
  });

  it("persists the resolved auto-queue decision in the tick report", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-self-optimize-report-"));
    mkdirSync(path.join(workbench, "config"), { recursive: true });
    writeFileSync(
      path.join(workbench, "config", "self-optimize.json"),
      JSON.stringify({
        autoQueueBookRevise: false,
        preferredBookWorkflow: "axiom-book",
      }),
      "utf8",
    );

    const report = runSelfOptimize(workbench);
    expect(report.autoQueueBookRevise).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(workbench, "state", "self-optimize.json"), "utf8")),
    ).toMatchObject({ autoQueueBookRevise: false });
  });

  it("fails closed when a present mutation config is malformed", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-self-optimize-config-"));
    mkdirSync(path.join(workbench, "config"), { recursive: true });
    writeFileSync(path.join(workbench, "config", "self-optimize.json"), "{broken", "utf8");
    expect(() => loadSelfOptimizeConfig(workbench)).toThrow(/refusing mutation/i);

    writeFileSync(
      path.join(workbench, "config", "self-optimize.json"),
      JSON.stringify({ enabled: "yes" }),
      "utf8",
    );
    expect(() => loadSelfOptimizeConfig(workbench)).toThrow(/invalid control fields/i);
  });

  it("refuses to activate a preferred workflow that does not exist", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-self-optimize-workflow-"));
    mkdirSync(path.join(workbench, "config"), { recursive: true });
    writeFileSync(
      path.join(workbench, "config", "self-optimize.json"),
      JSON.stringify({ preferredBookWorkflow: "missing-workflow" }),
      "utf8",
    );
    expect(() => runSelfOptimize(workbench)).toThrow(/does not exist/i);
  });

  it("refuses to compare a preferred workflow under a different eval profile", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-self-optimize-proposal-"));
    mkdirSync(path.join(workbench, "config"), { recursive: true });
    writeFileSync(
      path.join(workbench, "config", "self-optimize.json"),
      JSON.stringify({ preferredBookWorkflow: "default" }),
      "utf8",
    );

    const report = runSelfOptimize(workbench);
    expect(report.workflowSelection).toMatchObject({
      workflowId: "axiom-book",
      baselineWorkflowId: "axiom-book",
      active: false,
    });
    expect(report.workflowSelection?.experimentId).toBeUndefined();
    expect(report.recommendedActions.join("\n")).toMatch(/different eval profile/i);
    expect(existsSync(path.join(workbench, "state", "workflow-selection.json"))).toBe(false);
  });

  it("proposes a same-profile candidate without queueing or activating it", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-self-optimize-candidate-"));
    scaffoldAxiomPrompts(workbench);
    const report = runSelfOptimize(workbench);
    expect(report.workflowSelection).toMatchObject({
      workflowId: "variants/axiom-book-lean-v2",
      baselineWorkflowId: "axiom-book",
      active: false,
      experimentStatus: "proposed",
    });
    expect(report.workflowSelection?.experimentId).toMatch(/^wfexp-/);
    expect(existsSync(path.join(workbench, "state", "workflow-selection.json"))).toBe(false);
    expect(existsSync(path.join(workbench, "queue", "now.yaml"))).toBe(false);
  });

  it("fails before durable tick mutations when a legacy selection exists", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-self-optimize-legacy-"));
    scaffoldAxiomPrompts(workbench);
    mkdirSync(path.join(workbench, "state"), { recursive: true });
    const legacy = {
      workflowId: "variants/default-debate-v2",
      score: 62,
      reasons: ["legacy score"],
      updatedAt: "2026-07-08T16:08:18.220Z",
    };
    const selectionPath = path.join(workbench, "state", "workflow-selection.json");
    writeFileSync(selectionPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    expect(() => runSelfOptimize(workbench)).toThrow(/present but invalid or untrusted/i);
    expect(JSON.parse(readFileSync(selectionPath, "utf8"))).toEqual(legacy);
    expect(existsSync(path.join(workbench, "state", "workflow-experiments"))).toBe(false);
    expect(existsSync(path.join(workbench, "state", "quality-scan.json"))).toBe(false);
    expect(existsSync(path.join(workbench, "state", "mcp-hints.json"))).toBe(false);
    expect(existsSync(path.join(workbench, "state", "self-optimize.json"))).toBe(false);
  });

  it("fails before durable tick mutations when selection recovery state is orphaned", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-self-optimize-orphan-"));
    scaffoldAxiomPrompts(workbench);
    mkdirSync(path.join(workbench, "state"), { recursive: true });
    const orphan = path.join(
      workbench,
      "state",
      "workflow-selection.json.preimage-crashed-self-optimize",
    );
    writeFileSync(orphan, "{\"selectionVersion\":1}\n", "utf8");

    expect(() => runSelfOptimize(workbench)).toThrow(/orphaned preimage or recovery state/i);
    expect(readFileSync(orphan, "utf8")).toBe("{\"selectionVersion\":1}\n");
    expect(existsSync(path.join(workbench, "state", "workflow-experiments"))).toBe(false);
    expect(existsSync(path.join(workbench, "state", "mcp-hints.json"))).toBe(false);
    expect(existsSync(path.join(workbench, "state", "self-optimize.json"))).toBe(false);
  });
});
