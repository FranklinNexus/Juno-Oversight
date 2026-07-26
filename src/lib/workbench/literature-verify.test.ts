import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveLiteratureVerificationBinding,
  verifyLiteratureArtifacts,
} from "../../../orchestrator/src/literature-verify.js";
import { buildManifestFromQueue } from "../../../orchestrator/src/manifest.js";
import { readNowQueueSnapshot } from "../../../orchestrator/src/queue-io.js";
import type { QueueItem, RunManifest } from "../../../orchestrator/src/types.js";
import {
  proposeWorkflowExperiment,
  queueWorkflowExperiment,
  workflowExperimentPaths,
  type WorkflowExperimentProposal,
} from "../../../orchestrator/src/workflow-experiment.js";
import { literatureArtifactChecksForManifest } from "../../../orchestrator/src/verify-runner.js";

function canaryFixture(): {
  root: string;
  proposal: WorkflowExperimentProposal;
  manifest: RunManifest;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "juno-literature-canary-"));
  for (const relative of ["missions/juno-axiom-book-2026", "prompts", "queue", "runs", "state"]) {
    mkdirSync(path.join(root, relative), { recursive: true });
  }
  for (const template of [
    "executor_book_review",
    "executor_book_write",
    "executor_implement",
    "executor_verify",
  ]) {
    writeFileSync(path.join(root, "prompts", `${template}.md`), `# ${template}\n`);
  }
  const proposal = proposeWorkflowExperiment(root, {
    targetMissionId: "juno-axiom-book-2026",
    baselineWorkflowId: "axiom-book",
    candidateWorkflowId: "variants/axiom-book-lean-v2",
    requiredEpisodes: 2,
  });
  queueWorkflowExperiment(root, proposal.experimentId);
  const snapshot = readNowQueueSnapshot(root);
  const item = [...snapshot.now, ...snapshot.backlog].find(
    (entry): entry is QueueItem =>
      entry.experiment_id === proposal.experimentId &&
      entry.experiment_arm === "baseline" &&
      entry.experiment_episode === 1 &&
      entry.run_kind === "verify",
  );
  if (!item) throw new Error("Workflow canary verify item was not queued");
  const previous = process.env.AGENT_WORKBENCH_ROOT;
  process.env.AGENT_WORKBENCH_ROOT = root;
  try {
    return { root, proposal, manifest: buildManifestFromQueue(item) };
  } finally {
    if (previous === undefined) delete process.env.AGENT_WORKBENCH_ROOT;
    else process.env.AGENT_WORKBENCH_ROOT = previous;
  }
}

function receiptPath(root: string, proposal: WorkflowExperimentProposal): string {
  const proposalPath = workflowExperimentPaths(root, proposal.experimentId).proposal;
  return proposalPath.replace(/\.proposal\.json$/, ".baseline.1.fixture.json");
}

describe("literature artifact verify", () => {
  it("fails closed for unknown literature missions", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-literature-unknown-"));
    const checks = verifyLiteratureArtifacts(workbench, "unknown-mission");
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(false);
    expect(checks[0].detail).toContain("no deterministic validator");
  });

  it("does not pass an empty axiom-book mission", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-literature-book-"));
    const checks = verifyLiteratureArtifacts(workbench, "juno-axiom-book-2026");
    expect(checks.some((check) => !check.ok)).toBe(true);
    expect(checks.find((check) => check.label.includes("20 chapters"))?.ok).toBe(false);
  });

  it("binds a real canary verify slot to target rules while reading only sample artifacts", () => {
    const { root, proposal, manifest } = canaryFixture();
    const productionDir = path.join(root, "missions", proposal.targetMissionId);
    writeFileSync(
      path.join(productionDir, "axioms.md"),
      `${"A1 production-only content ".repeat(8)}\n`,
      "utf8",
    );

    const binding = resolveLiteratureVerificationBinding(root, manifest);
    expect(binding).toMatchObject({
      ok: true,
      validatorMissionId: proposal.targetMissionId,
      artifactMissionId: manifest.missionId,
      artifactMode: "workflow_canary_literature_v1",
    });
    expect(binding.checks.every((check) => check.ok)).toBe(true);

    const checks = literatureArtifactChecksForManifest(root, manifest);
    expect(checks.find((check) => check.label === "workflow canary literature binding")?.ok).toBe(
      true,
    );
    const essayLength = checks.find((check) => check.label.includes("450-900"));
    expect(essayLength).toMatchObject({ ok: false });
    expect(checks.some((check) => check.detail.includes(productionDir))).toBe(false);
    expect(checks.some((check) => !check.ok)).toBe(true);
  });

  it("accepts an attainable isolated literature micro-fixture", () => {
    const { root, manifest } = canaryFixture();
    const body = Array.from(
      { length: 18 },
      (_, index) =>
        `Auditable oversight makes each policy decision reconstructable and falsifiable when evidence changes, while review cycle ${index + 1} tests a concrete failure condition.`,
    ).join(" ");
    const essay = [
      "# Auditable Oversight",
      "",
      "## Thesis",
      "Auditable AI oversight should be accepted only when a reviewer can falsify its safety claim [S1].",
      body,
      "",
      "## Argument",
      "Append-only decision records connect evidence to action and support independent reconstruction [S2].",
      body,
      "",
      "## Counterargument",
      "A fixed monitor may appear sufficient, but distribution shift creates a serious objection and requires explicit re-evaluation [S3].",
      "",
      "## Conclusion",
      "The resulting oversight contract is observable, auditable, and falsifiable.",
      "",
    ].join("\n");
    writeFileSync(path.join(root, "missions", manifest.missionId!, "essay.md"), essay, "utf8");
    const checks = literatureArtifactChecksForManifest(root, manifest);
    expect(checks.every((check) => check.ok), JSON.stringify(checks, null, 2)).toBe(true);
  });

  it("rejects a canary mission whose experiment episode metadata was forged", () => {
    const { root, proposal, manifest } = canaryFixture();
    const forgedMissionId = `${proposal.experimentMissionId}-b2`;
    const binding = resolveLiteratureVerificationBinding(root, {
      ...manifest,
      missionId: forgedMissionId,
      cwd: `missions/${forgedMissionId}`,
    });
    expect(binding.ok).toBe(false);
    expect(binding.checks[0].detail).toMatch(/trusted proposal/i);
  });

  it("rejects a canary with missing experiment metadata", () => {
    const { root, manifest } = canaryFixture();
    const binding = resolveLiteratureVerificationBinding(root, {
      ...manifest,
      experimentFixtureSha256: undefined,
    });
    expect(binding.ok).toBe(false);
    expect(binding.checks[0].detail).toMatch(/metadata is incomplete/i);
  });

  it("rejects a fixture receipt whose rendered fixture hash was altered", () => {
    const { root, proposal, manifest } = canaryFixture();
    const target = receiptPath(root, proposal);
    const receipt = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
    receipt.renderedFilesSha256 = "0".repeat(64);
    writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

    const binding = resolveLiteratureVerificationBinding(root, manifest);
    expect(binding.ok).toBe(false);
    expect(binding.checks[0].detail).toMatch(/fixture receipt binding is invalid/i);
  });

  it("does not follow a sample artifact hard link into the production mission", () => {
    const { root, proposal, manifest } = canaryFixture();
    const productionArtifact = path.join(
      root,
      "missions",
      proposal.targetMissionId,
      "axioms.md",
    );
    writeFileSync(productionArtifact, `${"A1 production-only content ".repeat(8)}\n`, "utf8");
    linkSync(
      productionArtifact,
      path.join(root, "missions", manifest.missionId!, "axioms.md"),
    );
    const binding = resolveLiteratureVerificationBinding(root, manifest);
    const checks = verifyLiteratureArtifacts(
      root,
      binding.validatorMissionId,
      binding.artifactMissionId,
    );
    expect(checks.find((check) => check.label === "axioms.md is substantive")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("unsafe linked artifact"),
    });
  });

  it("rejects a sample mission directory link to the production mission", () => {
    const { root, proposal, manifest } = canaryFixture();
    const sampleDir = path.join(root, "missions", manifest.missionId!);
    const productionDir = path.join(root, "missions", proposal.targetMissionId);
    rmSync(sampleDir, { recursive: true, force: true });
    symlinkSync(productionDir, sampleDir, process.platform === "win32" ? "junction" : "dir");

    const binding = resolveLiteratureVerificationBinding(root, manifest);
    expect(binding.ok).toBe(false);
    expect(binding.checks[0].detail).toMatch(/artifact mission must be a regular directory/i);
  });
});
