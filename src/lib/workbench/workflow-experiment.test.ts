import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildManifestFromQueue,
  buildUserPrompt,
  loadRunState,
  materializeQueueRun,
} from "../../../orchestrator/src/manifest.js";
import { buildReviseImplementItem } from "../../../orchestrator/src/mission-progress.js";
import { evidenceSha256 } from "../../../orchestrator/src/execution-artifact.js";
import {
  readNowQueueSnapshot,
  replaceQueueSnapshotConditional,
} from "../../../orchestrator/src/queue-io.js";
import { readActiveWorkflowSelection } from "../../../orchestrator/src/workflow-search.js";
import { workflowsDir } from "../../../orchestrator/src/workflow.js";
import type { QueueItem } from "../../../orchestrator/src/types.js";
import {
  compileWorkflowExperimentArmEpisode,
  evaluateWorkflowExperiment,
  inspectWorkflowExperiment,
  listWorkflowExperimentIds,
  promoteWorkflowExperiment,
  proposeWorkflowExperiment,
  queueWorkflowExperiment,
  readWorkflowExperimentRevisionPromptBinding,
  rollbackWorkflowExperiment,
  workflowExperimentPaths,
  workflowExperimentSampleMissionId,
  workflowSelectionLockPath,
  workflowSelectionPath,
  type WorkflowExperimentProposal,
} from "../../../orchestrator/src/workflow-experiment.js";
import {
  passingExperimentCheckpoint,
  writeTrustedExperimentRunEvidence,
} from "./workflow-experiment-evidence.test-helper.js";

const WORKFLOW_INTEGRATION_TIMEOUT_MS = 30_000;

function workbench(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "juno-workflow-experiment-"));
  for (const relative of ["missions/target", "prompts", "queue", "runs", "state"]) {
    mkdirSync(path.join(root, relative), { recursive: true });
  }
  for (const template of [
    "executor_book_review",
    "executor_book_write",
    "executor_implement",
    "executor_review",
    "executor_verify",
  ]) {
    writeFileSync(path.join(root, "prompts", `${template}.md`), `# ${template}\n`);
  }
  return root;
}

function replaceWithDirectoryLink(target: string, outside: string): void {
  rmSync(target, { recursive: true, force: true });
  symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
}

function experimentItems(root: string, experimentId: string): QueueItem[] {
  const snapshot = readNowQueueSnapshot(root);
  return [...snapshot.now, ...snapshot.backlog].filter(
    (item) => item.experiment_id === experimentId,
  );
}

function writePassingEvidence(root: string, proposal: WorkflowExperimentProposal): QueueItem[] {
  const items = experimentItems(root, proposal.experimentId);
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    writeTrustedExperimentRunEvidence(root, item);
  }
  return items;
}

function addRevisionEvidence(
  root: string,
  proposal: WorkflowExperimentProposal,
  items: QueueItem[],
  arm: "baseline" | "candidate",
  attemptsPerEpisode: number,
): void {
  for (let episode = 1; episode <= proposal.requiredEpisodes; episode += 1) {
    const parent = items.find(
      (item) =>
        item.experiment_arm === arm &&
        item.experiment_episode === episode &&
        (item.run_kind === "review" || item.run_kind === "debate"),
    )!;
    const mustFix = [`fixture revision for ${arm} episode ${episode}`];
    writeTrustedExperimentRunEvidence(
      root,
      parent,
      [
        "## REVIEW_VERDICT",
        "verdict: REVISE",
        "drift: none",
        "scope_violations: []",
        `must_fix_next_slot: [${JSON.stringify(mustFix[0])}]`,
        "reviewer_notes: fixture requests bounded revision evidence",
        "",
      ].join("\n"),
    );
    const binding = readWorkflowExperimentRevisionPromptBinding(root, parent);
    for (let attempt = 1; attempt <= attemptsPerEpisode; attempt += 1) {
      const fix = buildReviseImplementItem(parent, attempt, mustFix, binding);
      writeTrustedExperimentRunEvidence(
        root,
        fix,
        passingExperimentCheckpoint("implement"),
      );
    }
  }
}

function acceptedExperiment(root: string): WorkflowExperimentProposal {
  const proposal = proposeWorkflowExperiment(root, {
    targetMissionId: "target",
    baselineWorkflowId: "axiom-book",
    candidateWorkflowId: "variants/axiom-book-lean-v2",
    requiredEpisodes: 2,
  });
  queueWorkflowExperiment(root, proposal.experimentId);
  writePassingEvidence(root, proposal);
  expect(evaluateWorkflowExperiment(root, proposal.experimentId).status).toBe("accepted");
  return proposal;
}

function acceptedChainedExperiment(root: string): {
  proposal: WorkflowExperimentProposal;
  previousSelection: string;
} {
  const first = proposeWorkflowExperiment(root, {
    targetMissionId: "target",
    baselineWorkflowId: "axiom-book",
    candidateWorkflowId: "variants/axiom-book-lean-v2",
    sourcePhaseId: "first-chain",
    requiredEpisodes: 2,
  });
  queueWorkflowExperiment(root, first.experimentId);
  writePassingEvidence(root, first);
  expect(evaluateWorkflowExperiment(root, first.experimentId).status).toBe("accepted");
  promoteWorkflowExperiment(root, first.experimentId);
  const previousSelection = readFileSync(workflowSelectionPath(root), "utf8");

  const proposal = proposeWorkflowExperiment(root, {
    targetMissionId: "target",
    baselineWorkflowId: "variants/axiom-book-lean-v2",
    candidateWorkflowId: "axiom-book",
    sourcePhaseId: "second-chain",
    requiredEpisodes: 2,
  });
  queueWorkflowExperiment(root, proposal.experimentId);
  const items = writePassingEvidence(root, proposal);
  addRevisionEvidence(root, proposal, items, "baseline", 4);
  expect(evaluateWorkflowExperiment(root, proposal.experimentId).status).toBe("accepted");
  return { proposal, previousSelection };
}

function holdSelectionLock(root: string): ChildProcessWithoutNullStreams {
  const script = [
    "const fs = require('node:fs');",
    "const lock = process.argv[1];",
    "const fd = fs.openSync(lock, 'wx');",
    "fs.writeFileSync(fd, JSON.stringify({ token: 'external-owner', pid: process.pid, acquiredAt: Date.now() }) + '\\n');",
    "fs.closeSync(fd);",
    "process.stdout.write('ready\\n');",
    "process.stdin.once('data', () => { fs.unlinkSync(lock); process.exit(0); });",
  ].join("\n");
  return spawn(process.execPath, ["-e", script, workflowSelectionLockPath(root)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("workflow experiment isolation and policy", () => {
  it("keeps experiment path and missing reads side-effect free on a fresh Workbench", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "juno-workflow-experiment-fresh-"));
    const stateRoot = path.join(root, "state");
    const paths = workflowExperimentPaths(root, "missing-experiment");

    expect(paths.proposal.startsWith(path.join(stateRoot, "workflow-experiments")))
      .toBe(true);
    expect(listWorkflowExperimentIds(root)).toEqual([]);
    expect(() => inspectWorkflowExperiment(root, "missing-experiment"))
      .toThrow(/does not exist/i);
    expect(existsSync(stateRoot)).toBe(false);
  });

  it("reads revision prompt hashes only from the immutable running proposal", () => {
    const root = workbench();
    const missingParent: QueueItem = {
      id: "missing-review",
      horizon: "mission",
      kind: "review",
      run_kind: "review",
      prompt: "executor_review",
      experiment_id: "missing-experiment",
    };
    expect(() => readWorkflowExperimentRevisionPromptBinding(root, missingParent))
      .toThrow(/does not exist/i);

    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    const proposedParent = compileWorkflowExperimentArmEpisode(proposal, "baseline", 1).find(
      (item) => item.run_kind === "review",
    )!;
    expect(() => readWorkflowExperimentRevisionPromptBinding(root, proposedParent))
      .toThrow(/not running/i);

    queueWorkflowExperiment(root, proposal.experimentId);
    const parent = experimentItems(root, proposal.experimentId).find(
      (item) => item.id === proposedParent.id,
    )!;
    expect(readWorkflowExperimentRevisionPromptBinding(root, parent)).toEqual({
      experimentId: proposal.experimentId,
      promptSha256ByTemplate: proposal.promptSha256ByTemplate,
    });

    writeFileSync(path.join(root, "prompts", "executor_book_write.md"), "# drifted write\n");
    expect(() => readWorkflowExperimentRevisionPromptBinding(root, parent))
      .toThrow(/prompt bundle changed after proposal/i);

    const driftedRoot = workbench();
    const driftedProposal = proposeWorkflowExperiment(driftedRoot, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(driftedRoot, driftedProposal.experimentId);
    const driftedParent = experimentItems(driftedRoot, driftedProposal.experimentId).find(
      (item) => item.experiment_arm === "baseline" && item.run_kind === "review",
    )!;
    const proposalPath = workflowExperimentPaths(
      driftedRoot,
      driftedProposal.experimentId,
    ).proposal;
    const changedProposal = JSON.parse(readFileSync(proposalPath, "utf8"));
    changedProposal.createdAt = new Date(Date.parse(changedProposal.createdAt) + 1_000).toISOString();
    writeFileSync(proposalPath, `${JSON.stringify(changedProposal, null, 2)}\n`, "utf8");
    expect(() => readWorkflowExperimentRevisionPromptBinding(
      driftedRoot,
      driftedParent,
    )).toThrow(/running record binding is invalid/i);
  });

  it("rejects forged or terminal experiment revision parents before queue mutation", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const items = experimentItems(root, proposal.experimentId);
    const parent = items.find(
      (item) => item.experiment_arm === "baseline" && item.run_kind === "review",
    )!;
    const forgedParents: QueueItem[] = [
      { ...parent, mission_id: "juno-workflow-canary-forged" },
      { ...parent, experiment_arm: "candidate" },
      { ...parent, experiment_episode: 2 },
      { ...parent, workflow_id: "variants/axiom-book-lean-v2" },
      { ...parent, experiment_fixture_sha256: "0".repeat(64) },
      { ...parent, phase_id: "forged-review" },
      { ...parent, run_kind: "implement" },
    ];
    for (const forged of forgedParents) {
      expect(() => readWorkflowExperimentRevisionPromptBinding(root, forged))
        .toThrow(/parent binding does not match its immutable proposal/i);
    }
    const implementParent = items.find(
      (item) => item.experiment_arm === "baseline" && item.run_kind === "implement",
    )!;
    expect(() => readWorkflowExperimentRevisionPromptBinding(root, implementParent))
      .toThrow(/not a compiled review slot/i);

    writePassingEvidence(root, proposal);
    expect(evaluateWorkflowExperiment(root, proposal.experimentId).status)
      .toMatch(/accepted|rejected/);
    expect(() => readWorkflowExperimentRevisionPromptBinding(root, parent))
      .toThrow(/terminal workflow experiment/i);
  });

  it("materializes and builds a generic revision prompt from the proposal target hash", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const parent = experimentItems(root, proposal.experimentId).find(
      (item) => item.experiment_arm === "baseline" && item.run_kind === "review",
    )!;
    const fix = buildReviseImplementItem(
      parent,
      1,
      ["strengthen the evidence chain"],
      readWorkflowExperimentRevisionPromptBinding(root, parent),
    );

    expect(parent.prompt).toBe("executor_book_review");
    expect(fix.prompt).toBe("executor_book_write");
    expect(fix.experiment_prompt_sha256).toBe(
      proposal.promptSha256ByTemplate.executor_book_write,
    );
    expect(fix.experiment_prompt_sha256).not.toBe(parent.experiment_prompt_sha256);

    const priorWorkbench = process.env.AGENT_WORKBENCH_ROOT;
    process.env.AGENT_WORKBENCH_ROOT = root;
    let manifestPath: string;
    try {
      manifestPath = materializeQueueRun(fix);
    } finally {
      if (priorWorkbench === undefined) delete process.env.AGENT_WORKBENCH_ROOT;
      else process.env.AGENT_WORKBENCH_ROOT = priorWorkbench;
    }
    const runDir = path.dirname(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const userPrompt = buildUserPrompt(manifest, root, runDir, loadRunState(runDir));

    expect(manifest).toMatchObject({
      promptTemplate: "executor_book_write",
      experimentPromptSha256: proposal.promptSha256ByTemplate.executor_book_write,
      revisionOf: parent.id,
      revisionAttempt: 1,
    });
    expect(userPrompt).toContain("# executor_book_write");
  });

  it("binds prompt bytes at proposal time and blocks queueing after drift", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "meta-loop",
      candidateWorkflowId: "self-iterate-p1",
      requiredEpisodes: 2,
    });
    writeFileSync(path.join(root, "prompts", "executor_review.md"), "# drifted prompt\n");
    expect(() => queueWorkflowExperiment(root, proposal.experimentId)).toThrow(
      /prompt bundle changed after proposal/i,
    );
    expect(readNowQueueSnapshot(root)).toMatchObject({ now: [], backlog: [] });
    expect(existsSync(workflowExperimentPaths(root, proposal.experimentId).running)).toBe(false);
  });

  it("rejects a hard-linked generated canary prompt before queueing", () => {
    const root = workbench();
    const targetMissionId = "juno-axiom-book-2026";
    mkdirSync(path.join(root, "missions", targetMissionId), { recursive: true });
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId,
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    const source = path.join(root, "foreign-canary-prompt.md");
    writeFileSync(source, "# untrusted prompt bytes\n", "utf8");
    linkSync(
      source,
      path.join(root, "prompts", "workflow_canary_literature_v1.md"),
    );

    expect(() => queueWorkflowExperiment(root, proposal.experimentId)).toThrow(
      /exclusive regular file/i,
    );
    expect(readNowQueueSnapshot(root)).toMatchObject({ now: [], backlog: [] });
    expect(existsSync(workflowExperimentPaths(root, proposal.experimentId).running)).toBe(false);
  });

  it("refuses a linked missions root before canary scaffold writes escape", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    const outside = mkdtempSync(path.join(os.tmpdir(), "juno-canary-missions-outside-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "unchanged\n", "utf8");
    const before = readdirSync(outside);
    replaceWithDirectoryLink(path.join(root, "missions"), outside);

    expect(() => queueWorkflowExperiment(root, proposal.experimentId)).toThrow(
      /Workbench missions root must be a non-link directory/i,
    );
    expect(readdirSync(outside)).toEqual(before);
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
    expect(readNowQueueSnapshot(root)).toMatchObject({ now: [], backlog: [] });
    expect(existsSync(workflowExperimentPaths(root, proposal.experimentId).running)).toBe(false);
  });

  it("refuses a linked state root before experiment or selection state escapes", () => {
    const root = workbench();
    const outside = mkdtempSync(path.join(os.tmpdir(), "juno-canary-state-outside-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "unchanged\n", "utf8");
    const before = readdirSync(outside);
    replaceWithDirectoryLink(path.join(root, "state"), outside);

    expect(() => proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    })).toThrow(/Workbench state root must be a non-link directory/i);
    expect(readdirSync(outside)).toEqual(before);
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged\n");
  });

  it("fails closed on linked, oversized, or invalid UTF-8 proposal bytes", () => {
    const linkedRoot = workbench();
    const linkedProposal = proposeWorkflowExperiment(linkedRoot, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    const linkedPath = workflowExperimentPaths(
      linkedRoot,
      linkedProposal.experimentId,
    ).proposal;
    linkSync(linkedPath, path.join(linkedRoot, "foreign-proposal.json"));
    expect(() => inspectWorkflowExperiment(linkedRoot, linkedProposal.experimentId))
      .toThrow(/exclusive regular file/i);

    const oversizedRoot = workbench();
    const oversizedProposal = proposeWorkflowExperiment(oversizedRoot, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    writeFileSync(
      workflowExperimentPaths(oversizedRoot, oversizedProposal.experimentId).proposal,
      "x".repeat(256 * 1024 + 1),
    );
    expect(() => inspectWorkflowExperiment(oversizedRoot, oversizedProposal.experimentId))
      .toThrow(/exceeds the 262144-byte limit/i);

    const invalidRoot = workbench();
    const invalidProposal = proposeWorkflowExperiment(invalidRoot, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    writeFileSync(
      workflowExperimentPaths(invalidRoot, invalidProposal.experimentId).proposal,
      Buffer.from([0xc3, 0x28]),
    );
    expect(() => inspectWorkflowExperiment(invalidRoot, invalidProposal.experimentId))
      .toThrow(/must be valid UTF-8/i);
  });

  it("enforces the registered evaluation domain for known literature missions", () => {
    const root = workbench();
    expect(() => proposeWorkflowExperiment(root, {
      targetMissionId: "juno-axiom-book-2026",
      baselineWorkflowId: "meta-loop",
      candidateWorkflowId: "self-iterate-p1",
      requiredEpisodes: 2,
    })).toThrow(/requires eval profile literature/i);
    expect(existsSync(workflowSelectionPath(root))).toBe(false);
  });

  it("activates an explicitly queued canary when now is empty without reordering foreign backlog", () => {
    const root = workbench();
    const foreign: QueueItem = {
      id: "foreign-deferred",
      horizon: "mission",
      kind: "implement",
      run_kind: "implement",
      prompt: "executor_implement",
      mission_id: "target",
      phase_id: "foreign",
    };
    expect(replaceQueueSnapshotConditional(root, {
      expectedRevision: null,
      now: [],
      backlog: [foreign],
    }).ok).toBe(true);
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    const queued = queueWorkflowExperiment(root, proposal.experimentId);
    const snapshot = readNowQueueSnapshot(root);
    expect(queued.location).toBe("now");
    expect(snapshot.now.length).toBeGreaterThan(0);
    expect(snapshot.now.every((item) => item.experiment_id === proposal.experimentId)).toBe(true);
    expect(snapshot.backlog).toEqual([foreign]);
  });

  it("promotes an already-backlogged canary when the active queue becomes empty", () => {
    const root = workbench();
    const blocker: QueueItem = {
      id: "active-blocker",
      horizon: "mission",
      kind: "implement",
      run_kind: "implement",
      prompt: "executor_implement",
      mission_id: "target",
      phase_id: "blocker",
    };
    expect(replaceQueueSnapshotConditional(root, {
      expectedRevision: null,
      now: [blocker],
      backlog: [],
    }).ok).toBe(true);
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    expect(queueWorkflowExperiment(root, proposal.experimentId).location).toBe("backlog");
    const queued = readNowQueueSnapshot(root);
    expect(replaceQueueSnapshotConditional(root, {
      expectedRevision: queued.revision,
      now: [],
      backlog: queued.backlog,
    }).ok).toBe(true);
    const promoted = queueWorkflowExperiment(root, proposal.experimentId);
    const active = readNowQueueSnapshot(root);
    expect(promoted).toMatchObject({ queued: 0, location: "now" });
    expect(active.now.length).toBeGreaterThan(0);
    expect(active.backlog).toEqual([]);
  });

  it("uses isolated sample missions backed by one immutable fixture template", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const items = experimentItems(root, proposal.experimentId);
    const missionIds = new Set(items.map((item) => item.mission_id));
    expect(missionIds).toEqual(new Set([
      workflowExperimentSampleMissionId(proposal, "baseline", 1),
      workflowExperimentSampleMissionId(proposal, "candidate", 1),
      workflowExperimentSampleMissionId(proposal, "baseline", 2),
      workflowExperimentSampleMissionId(proposal, "candidate", 2),
    ]));
    expect(items.every((item) => item.experiment_fixture_sha256 === proposal.fixtureSha256)).toBe(true);

    const northStars = [...missionIds].map((missionId) =>
      readFileSync(path.join(root, "missions", missionId!, "north-star.md"), "utf8"),
    );
    const progressFiles = [...missionIds].map((missionId) =>
      readFileSync(path.join(root, "missions", missionId!, "progress.md"), "utf8"),
    );
    expect(new Set(northStars).size).toBe(1);
    expect(new Set(progressFiles).size).toBe(1);
    const normalizedScopes = [...missionIds].map((missionId) =>
      readFileSync(path.join(root, "missions", missionId!, "scope-lock.md"), "utf8")
        .replaceAll(missionId!, "<sample>"),
    );
    expect(new Set(normalizedScopes).size).toBe(1);

    const baselineMission = workflowExperimentSampleMissionId(proposal, "baseline", 1);
    const candidateMission = workflowExperimentSampleMissionId(proposal, "candidate", 1);
    writeFileSync(path.join(root, "missions", baselineMission, "baseline-only.txt"), "secret", "utf8");
    expect(existsSync(path.join(root, "missions", candidateMission, "baseline-only.txt"))).toBe(false);

    const previousRoot = process.env.AGENT_WORKBENCH_ROOT;
    process.env.AGENT_WORKBENCH_ROOT = root;
    try {
      const baselineManifest = buildManifestFromQueue(
        items.find((item) => item.experiment_arm === "baseline" && item.experiment_episode === 1)!,
      );
      const candidateManifest = buildManifestFromQueue(
        items.find((item) => item.experiment_arm === "candidate" && item.experiment_episode === 1)!,
      );
      expect(baselineManifest.cwd).not.toBe(candidateManifest.cwd);
      expect(baselineManifest.experimentFixtureSha256).toBe(proposal.fixtureSha256);
      expect(candidateManifest.experimentFixtureSha256).toBe(proposal.fixtureSha256);
    } finally {
      if (previousRoot === undefined) delete process.env.AGENT_WORKBENCH_ROOT;
      else process.env.AGENT_WORKBENCH_ROOT = previousRoot;
    }
  });

  it("refuses incomparable eval profiles and foreign-mission selection preimages", () => {
    const root = workbench();
    expect(() => proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "default",
    })).toThrow(/matching eval profiles/i);

    const foreign = `${JSON.stringify({ missionId: "another-mission", active: true })}\n`;
    writeFileSync(workflowSelectionPath(root), foreign, "utf8");
    expect(() => proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
    })).toThrow(/another mission/i);
    expect(readFileSync(workflowSelectionPath(root), "utf8")).toBe(foreign);
  });

  it("rejects equal metrics instead of promoting a no-benefit candidate", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const items = writePassingEvidence(root, proposal);
    addRevisionEvidence(root, proposal, items, "baseline", 1);
    addRevisionEvidence(root, proposal, items, "candidate", 4);
    const result = evaluateWorkflowExperiment(root, proposal.experimentId);
    expect(result.status).toBe("rejected");
    expect(result.decision?.reason).toMatch(/no strict improvement/i);
    expect(() => promoteWorkflowExperiment(root, proposal.experimentId)).toThrow(/not accepted/i);
  });

  it("rejects the legacy manifest/state/checkpoint trio without machine provenance", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const victim = writePassingEvidence(root, proposal).find(
      (item) => item.run_kind === "implement",
    )!;
    const runDir = path.join(root, "runs", victim.id);
    rmSync(path.join(runDir, "codex-artifact.json"));
    rmSync(path.join(runDir, "events.jsonl"));

    expect(() => evaluateWorkflowExperiment(root, proposal.experimentId)).toThrow(
      /run events|execution artifact/i,
    );
  });

  it("rejects a completed run whose executor events are missing", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const victim = writePassingEvidence(root, proposal).find(
      (item) => item.run_kind === "review",
    )!;
    rmSync(path.join(root, "runs", victim.id, "events.jsonl"));

    expect(() => evaluateWorkflowExperiment(root, proposal.experimentId)).toThrow(/run events/i);
  });

  it("rejects drift in deterministic verify machine evidence", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const victim = writePassingEvidence(root, proposal).find(
      (item) => item.run_kind === "verify",
    )!;
    const artifactPath = path.join(root, "runs", victim.id, "verify-artifact.json");
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    artifact.steps[0].exitCode = 9;
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    expect(() => evaluateWorkflowExperiment(root, proposal.experimentId)).toThrow(
      /verify step evidence/i,
    );
  });

  it("rejects a substituted verify command even when hashes and PASS results are updated", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const victim = writePassingEvidence(root, proposal).find(
      (item) => item.run_kind === "verify",
    )!;
    const runDir = path.join(root, "runs", victim.id);
    const artifactPath = path.join(runDir, "verify-artifact.json");
    const eventsPath = path.join(runDir, "events.jsonl");
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    const step = artifact.steps.find((entry: { command: string }) =>
      !entry.command.startsWith("orchestrator:"));
    step.command = `${process.execPath} -e process.exit(0)`;
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((line) =>
      JSON.parse(line));
    for (const event of events.filter((entry) => entry.stepId === step.stepId)) {
      event.tool = process.execPath;
      event.args = "-e process.exit(0)";
    }
    const eventsText = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    writeFileSync(eventsPath, eventsText, "utf8");
    artifact.eventsSha256 = evidenceSha256(eventsText);
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    expect(() => evaluateWorkflowExperiment(root, proposal.experimentId)).toThrow(
      /verify profile step binding/i,
    );
  });

  it("rejects reordered verify tool events even when the artifact event hash is updated", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const victim = writePassingEvidence(root, proposal).find(
      (item) => item.run_kind === "verify",
    )!;
    const runDir = path.join(root, "runs", victim.id);
    const artifactPath = path.join(runDir, "verify-artifact.json");
    const eventsPath = path.join(runDir, "events.jsonl");
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((line) =>
      JSON.parse(line));
    const completed = events.find((event) =>
      event.type === "tool_call" && event.phase === "completed");
    completed.phase = "started";
    const eventsText = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    writeFileSync(eventsPath, eventsText, "utf8");
    artifact.eventsSha256 = evidenceSha256(eventsText);
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    expect(() => evaluateWorkflowExperiment(root, proposal.experimentId)).toThrow(
      /verify tool event binding/i,
    );
  });

  it("rejects run-state retry drift from artifact and event attempt bindings", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const victim = writePassingEvidence(root, proposal)[0]!;
    const statePath = path.join(root, "runs", victim.id, "run-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.retryCount = 1;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    expect(() => evaluateWorkflowExperiment(root, proposal.experimentId)).toThrow(
      /attempt binding/i,
    );
  });

  it("rejects an execution artifact copied from another run", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const verifyItems = writePassingEvidence(root, proposal).filter(
      (item) => item.run_kind === "verify",
    );
    const source = verifyItems[0]!;
    const target = verifyItems[1]!;
    copyFileSync(
      path.join(root, "runs", source.id, "verify-artifact.json"),
      path.join(root, "runs", target.id, "verify-artifact.json"),
    );

    expect(() => evaluateWorkflowExperiment(root, proposal.experimentId)).toThrow(
      /execution artifact binding/i,
    );
  });

  it("requires exact materialized queue-item and manifest bindings", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const victim = writePassingEvidence(root, proposal)[0]!;
    const runDir = path.join(root, "runs", victim.id);
    const queueItemPath = path.join(runDir, "queue-item.json");
    const queueItemText = readFileSync(queueItemPath, "utf8");
    const queueItem = JSON.parse(queueItemText);
    queueItem.max_minutes += 1;
    writeFileSync(queueItemPath, `${JSON.stringify(queueItem, null, 2)}\n`, "utf8");
    expect(() => evaluateWorkflowExperiment(root, proposal.experimentId)).toThrow(
      /queue item binding/i,
    );

    writeFileSync(queueItemPath, queueItemText, "utf8");
    const manifestPath = path.join(runDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.maxMinutes += 1;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    expect(() => evaluateWorkflowExperiment(root, proposal.experimentId)).toThrow(
      /manifest binding/i,
    );
  });

  it("rejects a lower-cost candidate when either arm lacks deterministic verify passes", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const items = writePassingEvidence(root, proposal);
    for (const item of items.filter((entry) => entry.run_kind === "verify")) {
      writeTrustedExperimentRunEvidence(
        root,
        item,
        "## VERIFY_REPORT\n- deterministic checks: FAIL\n",
        false,
      );
    }
    const result = evaluateWorkflowExperiment(root, proposal.experimentId);
    expect(result.status).toBe("rejected");
    expect(result.decision?.reason).toMatch(/deterministic verification gate failed/i);
    expect(result.metrics.baseline.verifyPasses).toBe(0);
    expect(result.metrics.candidate.verifyPasses).toBe(0);
  });

  it("accepts only an explicitly bound revision run whose compiled parent requested REVISE", () => {
    const root = workbench();
    const proposal = proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    });
    queueWorkflowExperiment(root, proposal.experimentId);
    const items = writePassingEvidence(root, proposal);
    const parent = items.find(
      (item) => item.experiment_arm === "baseline" && item.run_kind === "review",
    )!;
    const mustFix = ["strengthen the evidence chain"];
    writeTrustedExperimentRunEvidence(
      root,
      parent,
      [
        "## REVIEW_VERDICT",
        "verdict: REVISE",
        "drift: none",
        "scope_violations: []",
        `must_fix_next_slot: [${JSON.stringify(mustFix[0])}]`,
        "reviewer_notes: one bounded correction is required",
        "",
      ].join("\n"),
    );
    const fix = buildReviseImplementItem(
      parent,
      1,
      mustFix,
      readWorkflowExperimentRevisionPromptBinding(root, parent),
    );
    expect(fix.prompt).toBe("executor_book_write");
    expect(fix.experiment_prompt_sha256).toBe(
      proposal.promptSha256ByTemplate.executor_book_write,
    );
    expect(fix.experiment_prompt_sha256).not.toBe(parent.experiment_prompt_sha256);

    const priorWorkbench = process.env.AGENT_WORKBENCH_ROOT;
    process.env.AGENT_WORKBENCH_ROOT = root;
    let manifestPath: string;
    try {
      manifestPath = materializeQueueRun(fix);
    } finally {
      if (priorWorkbench === undefined) delete process.env.AGENT_WORKBENCH_ROOT;
      else process.env.AGENT_WORKBENCH_ROOT = priorWorkbench;
    }
    const runDir = path.dirname(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const userPrompt = buildUserPrompt(manifest, root, runDir, loadRunState(runDir));
    expect(manifest).toMatchObject({
      promptTemplate: "executor_book_write",
      experimentPromptSha256: proposal.promptSha256ByTemplate.executor_book_write,
      revisionOf: parent.id,
      revisionAttempt: 1,
    });
    expect(userPrompt).toContain("# executor_book_write");
    writeTrustedExperimentRunEvidence(
      root,
      fix,
      passingExperimentCheckpoint("implement"),
    );

    const result = evaluateWorkflowExperiment(root, proposal.experimentId);
    expect(result.status).toBe("accepted");
    const revision = result.decision?.evidence.find((entry) => entry.runId === fix.id);
    expect(revision).toMatchObject({
      revisionOf: parent.id,
      revisionAttempt: 1,
      runKind: "implement",
      observed: true,
    });
  });
});

describe("workflow experiment receipts and activation", () => {
  it("restores the exact preimage if lease ownership is lost after quarantine", () => {
    const root = workbench();
    const { proposal, previousSelection } = acceptedChainedExperiment(root);
    expect(() => promoteWorkflowExperiment(root, proposal.experimentId, {
      afterPreimageMoved: ({ lockPath }) => unlinkSync(lockPath),
    })).toThrow(/lost workflow selection/i);
    expect(readFileSync(workflowSelectionPath(root), "utf8")).toBe(previousSelection);
    expect(readdirSync(path.join(root, "state")).some((name) => name.includes(".preimage-")))
      .toBe(false);
  }, WORKFLOW_INTEGRATION_TIMEOUT_MS);

  it("never overwrites a foreign writer that appears after preimage quarantine", () => {
    const root = workbench();
    const { proposal, previousSelection } = acceptedChainedExperiment(root);
    const foreign = '{"foreign":true}\n';
    expect(() => promoteWorkflowExperiment(root, proposal.experimentId, {
      afterPreimageMoved: ({ targetPath }) => {
        writeFileSync(targetPath, foreign, { encoding: "utf8", flag: "wx" });
      },
    })).toThrow(/concurrent workflow selection writer/i);
    expect(readFileSync(workflowSelectionPath(root), "utf8")).toBe(foreign);
    const preimages = readdirSync(path.join(root, "state"))
      .filter((name) => name.includes(".preimage-"));
    expect(preimages).toHaveLength(1);
    expect(readFileSync(path.join(root, "state", preimages[0]!), "utf8"))
      .toBe(previousSelection);
    expect(() => readActiveWorkflowSelection(root, "target"))
      .toThrow(/orphaned preimage or recovery state/i);
  }, WORKFLOW_INTEGRATION_TIMEOUT_MS);

  it("blocks readers, proposals, and expected-null promotion on orphaned preimage state", () => {
    const root = workbench();
    const orphan = `${workflowSelectionPath(root)}.preimage-crashed-writer`;
    writeFileSync(orphan, '{"selectionVersion":1}\n');
    expect(() => readActiveWorkflowSelection(root, "target"))
      .toThrow(/orphaned preimage or recovery state/i);
    expect(() => proposeWorkflowExperiment(root, {
      experimentId: "orphaned-proposal",
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      requiredEpisodes: 2,
    })).toThrow(/orphaned preimage or recovery state/i);
    expect(existsSync(workflowExperimentPaths(root, "orphaned-proposal").proposal)).toBe(false);
    expect(existsSync(workflowSelectionPath(root))).toBe(false);
    expect(readFileSync(orphan, "utf8")).toBe('{"selectionVersion":1}\n');

    const queueRoot = workbench();
    const queuedProposal = proposeWorkflowExperiment(queueRoot, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      sourcePhaseId: "orphaned-queue",
      requiredEpisodes: 2,
    });
    writeFileSync(
      `${workflowSelectionPath(queueRoot)}.preimage-crashed-queue`,
      '{"selectionVersion":1}\n',
    );
    expect(() => queueWorkflowExperiment(queueRoot, queuedProposal.experimentId))
      .toThrow(/orphaned preimage or recovery state/i);
    expect(existsSync(workflowExperimentPaths(queueRoot, queuedProposal.experimentId).running))
      .toBe(false);
    expect(readNowQueueSnapshot(queueRoot)).toMatchObject({ now: [], backlog: [] });

    const promotionRoot = workbench();
    const proposal = acceptedExperiment(promotionRoot);
    const promotionOrphan = `${workflowSelectionPath(promotionRoot)}.preimage-crashed-promotion`;
    writeFileSync(promotionOrphan, '{"selectionVersion":1}\n');
    expect(() => promoteWorkflowExperiment(promotionRoot, proposal.experimentId))
      .toThrow(/orphaned preimage or recovery state/i);
    expect(existsSync(workflowSelectionPath(promotionRoot))).toBe(false);
    expect(readFileSync(promotionOrphan, "utf8")).toBe('{"selectionVersion":1}\n');
  });

  it("requires every chained canary baseline to equal the trusted active workflow", () => {
    const root = workbench();
    const proposal = acceptedExperiment(root);
    promoteWorkflowExperiment(root, proposal.experimentId);
    const active = readFileSync(workflowSelectionPath(root), "utf8");

    expect(() => proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "axiom-book",
      candidateWorkflowId: "variants/axiom-book-lean-v2",
      sourcePhaseId: "second-canary",
      requiredEpisodes: 2,
    })).toThrow(/baseline must match the trusted active workflow/i);
    expect(() => proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "meta-loop",
      candidateWorkflowId: "self-iterate-p1",
      sourcePhaseId: "cross-profile-canary",
      requiredEpisodes: 2,
    })).toThrow(/baseline must match the trusted active workflow/i);
    expect(readFileSync(workflowSelectionPath(root), "utf8")).toBe(active);
  });

  it("refuses to reuse or queue a proposal after its trusted selection preimage disappears", () => {
    const root = workbench();
    const activeExperiment = acceptedExperiment(root);
    promoteWorkflowExperiment(root, activeExperiment.experimentId);
    const input = {
      targetMissionId: "target",
      baselineWorkflowId: "variants/axiom-book-lean-v2",
      candidateWorkflowId: "axiom-book",
      sourcePhaseId: "stale-proposal-preimage",
      requiredEpisodes: 2,
    } as const;
    const stale = proposeWorkflowExperiment(root, input);
    expect(stale.previousSelection.exists).toBe(true);

    expect(rollbackWorkflowExperiment(root, activeExperiment.experimentId)).toEqual({
      restored: false,
    });
    expect(existsSync(workflowSelectionPath(root))).toBe(false);
    const queueBefore = readNowQueueSnapshot(root);

    expect(() => proposeWorkflowExperiment(root, input)).toThrow(/stale proposal reuse/i);
    expect(() => queueWorkflowExperiment(root, stale.experimentId)).toThrow(/stale experiment/i);
    expect(readNowQueueSnapshot(root).revision).toBe(queueBefore.revision);
    expect(existsSync(workflowExperimentPaths(root, stale.experimentId).running)).toBe(false);
  });

  it("refuses to chain from an active selection whose accepted receipt was lost", () => {
    const root = workbench();
    const first = acceptedExperiment(root);
    promoteWorkflowExperiment(root, first.experimentId);
    rmSync(workflowExperimentPaths(root, first.experimentId).decision);
    expect(() => readActiveWorkflowSelection(root, "target"))
      .toThrow(/decision receipt|invalid or untrusted/i);
    expect(() => proposeWorkflowExperiment(root, {
      targetMissionId: "target",
      baselineWorkflowId: "variants/axiom-book-lean-v2",
      candidateWorkflowId: "axiom-book",
      sourcePhaseId: "dead-preimage-check",
      requiredEpisodes: 2,
    })).toThrow(/not backed by an accepted decision/i);
  });

  it("fails closed when an active selection's bound prompt bytes drift", () => {
    const root = workbench();
    const proposal = acceptedExperiment(root);
    promoteWorkflowExperiment(root, proposal.experimentId);
    writeFileSync(path.join(root, "prompts", "executor_book_write.md"), "# drifted active prompt\n");

    expect(() => readActiveWorkflowSelection(root, "target"))
      .toThrow(/prompt bundle changed after proposal/i);
  });

  it("rolls back an accepted selection after the live candidate definition is damaged", () => {
    const root = workbench();
    const candidateWorkflowId = `variants/rollback-candidate-${path.basename(root)}`;
    const candidatePath = path.join(workflowsDir(), `${candidateWorkflowId}.json`);
    copyFileSync(
      path.join(workflowsDir(), "variants", "axiom-book-lean-v2.json"),
      candidatePath,
    );
    try {
      const proposal = proposeWorkflowExperiment(root, {
        targetMissionId: "target",
        baselineWorkflowId: "axiom-book",
        candidateWorkflowId,
        sourcePhaseId: "damaged-candidate-rollback",
        requiredEpisodes: 2,
      });
      queueWorkflowExperiment(root, proposal.experimentId);
      writePassingEvidence(root, proposal);
      expect(evaluateWorkflowExperiment(root, proposal.experimentId).status).toBe("accepted");
      promoteWorkflowExperiment(root, proposal.experimentId);

      writeFileSync(candidatePath, "{damaged candidate workflow\n", "utf8");
      expect(() => readActiveWorkflowSelection(root, "target")).toThrow(/workflow is unreadable/i);
      expect(rollbackWorkflowExperiment(root, proposal.experimentId)).toEqual({ restored: false });
      expect(existsSync(workflowSelectionPath(root))).toBe(false);
    } finally {
      rmSync(candidatePath, { force: true });
    }
  });

  it("never restores a previous selection whose accepted decision receipt is missing", () => {
    const root = workbench();
    const { proposal, previousSelection } = acceptedChainedExperiment(root);
    promoteWorkflowExperiment(root, proposal.experimentId);
    const active = readFileSync(workflowSelectionPath(root), "utf8");
    const previousExperimentId = (JSON.parse(previousSelection) as { experimentId: string })
      .experimentId;
    rmSync(workflowExperimentPaths(root, previousExperimentId).decision);

    expect(() => rollbackWorkflowExperiment(root, proposal.experimentId))
      .toThrow(/previous|not backed by an accepted decision/i);
    expect(readFileSync(workflowSelectionPath(root), "utf8")).toBe(active);
  }, WORKFLOW_INTEGRATION_TIMEOUT_MS);

  it("keeps rollback available after run evidence is purged", () => {
    const root = workbench();
    const proposal = acceptedExperiment(root);
    const decision = JSON.parse(
      readFileSync(workflowExperimentPaths(root, proposal.experimentId).decision, "utf8"),
    ) as { evidence: unknown[]; fixtureSha256: string };
    expect(decision.evidence.length).toBeGreaterThan(0);
    expect(decision.fixtureSha256).toBe(proposal.fixtureSha256);

    promoteWorkflowExperiment(root, proposal.experimentId);
    expect(readActiveWorkflowSelection(root, "target")).toBe("variants/axiom-book-lean-v2");
    rmSync(path.join(root, "runs"), { recursive: true, force: true });
    expect(inspectWorkflowExperiment(root, proposal.experimentId).status).toBe("accepted");
    expect(readActiveWorkflowSelection(root, "target")).toBe("variants/axiom-book-lean-v2");
    expect(rollbackWorkflowExperiment(root, proposal.experimentId)).toEqual({ restored: false });
    expect(existsSync(workflowSelectionPath(root))).toBe(false);
  });

  it("refuses rollback while orphaned recovery state exists and preserves the active selection", () => {
    const root = workbench();
    const proposal = acceptedExperiment(root);
    promoteWorkflowExperiment(root, proposal.experimentId);
    const active = readFileSync(workflowSelectionPath(root), "utf8");
    const orphan = `${workflowSelectionPath(root)}.rollback-crashed-rollback`;
    writeFileSync(orphan, active, "utf8");

    expect(() => rollbackWorkflowExperiment(root, proposal.experimentId))
      .toThrow(/orphaned preimage or recovery state/i);
    expect(readFileSync(workflowSelectionPath(root), "utf8")).toBe(active);
    expect(readFileSync(orphan, "utf8")).toBe(active);
  }, WORKFLOW_INTEGRATION_TIMEOUT_MS);

  it("requires retained evidence for first promotion and rejects forged activation hashes", () => {
    const root = workbench();
    const proposal = acceptedExperiment(root);
    const firstRun = experimentItems(root, proposal.experimentId)[0]!;
    rmSync(path.join(root, "runs", firstRun.id), { recursive: true, force: true });
    expect(() => promoteWorkflowExperiment(root, proposal.experimentId)).toThrow(/evidence changed/i);

    const root2 = workbench();
    const proposal2 = acceptedExperiment(root2);
    promoteWorkflowExperiment(root2, proposal2.experimentId);
    const target = workflowSelectionPath(root2);
    const selection = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
    const foreignBinding = { ...selection, missionId: "foreign-target" };
    writeFileSync(target, `${JSON.stringify(foreignBinding, null, 2)}\n`, "utf8");
    expect(() => readActiveWorkflowSelection(root2, "foreign-target"))
      .toThrow(/invalid or untrusted/i);
    selection.decisionReceiptSha256 = "0".repeat(64);
    writeFileSync(target, `${JSON.stringify(selection, null, 2)}\n`, "utf8");
    expect(() => readActiveWorkflowSelection(root2, "target"))
      .toThrow(/invalid or untrusted/i);
  }, WORKFLOW_INTEGRATION_TIMEOUT_MS);

  it("recovers a stale selection lease before promotion", () => {
    const root = workbench();
    const proposal = acceptedExperiment(root);
    const lock = workflowSelectionLockPath(root);
    const old = new Date(Date.now() - 10 * 60_000);
    writeFileSync(
      lock,
      `${JSON.stringify({ token: "dead-owner", pid: 999_999, acquiredAt: old.getTime() })}\n`,
      "utf8",
    );
    utimesSync(lock, old, old);
    expect(promoteWorkflowExperiment(root, proposal.experimentId).workflowId)
      .toBe("variants/axiom-book-lean-v2");
    expect(existsSync(lock)).toBe(false);
  }, WORKFLOW_INTEGRATION_TIMEOUT_MS);

  it("never overwrites a concurrent selection writer during promote or rollback", async () => {
    const root = workbench();
    const proposal = acceptedExperiment(root);
    const promoteHolder = holdSelectionLock(root);
    await once(promoteHolder.stdout, "data");
    try {
      expect(() => readActiveWorkflowSelection(root, "target")).toThrow(/busy/i);
      expect(() => promoteWorkflowExperiment(root, proposal.experimentId)).toThrow(/busy/i);
      expect(existsSync(workflowSelectionPath(root))).toBe(false);
    } finally {
      promoteHolder.stdin.write("release\n");
      await once(promoteHolder, "exit");
    }

    promoteWorkflowExperiment(root, proposal.experimentId);
    const active = readFileSync(workflowSelectionPath(root), "utf8");
    const rollbackHolder = holdSelectionLock(root);
    await once(rollbackHolder.stdout, "data");
    try {
      expect(() => rollbackWorkflowExperiment(root, proposal.experimentId)).toThrow(/busy/i);
      expect(readFileSync(workflowSelectionPath(root), "utf8")).toBe(active);
    } finally {
      rollbackHolder.stdin.write("release\n");
      await once(rollbackHolder, "exit");
    }
  }, WORKFLOW_INTEGRATION_TIMEOUT_MS);
});
