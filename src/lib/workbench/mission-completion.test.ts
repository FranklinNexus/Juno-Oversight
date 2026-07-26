import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  missionCompletionReceiptPath,
  finalizeOrdinaryVerifyQueueHead,
  finalizeSpecializedVerifyQueueHead,
  prepareOrdinaryVerifyCompletion,
  prepareSpecializedVerifyCompletion,
  readMissionCompletionReceipt,
  recoverExactPendingVerifyCompletion,
  recoverPendingVerifyCompletions,
  verifyCompletionIntentPath,
  writeOrdinaryVerifyCompletionReceipt,
  writeSpecializedVerifyCompletionReceipt,
} from "../../../orchestrator/src/mission-completion.js";
import {
  parseNowYaml,
  readNowQueueSnapshot,
  replaceQueueHeadConditional,
  saveNowQueue,
} from "../../../orchestrator/src/queue-io.js";
import {
  ensureMissionSafetyBaseline,
  missionSafetyBaselinePath,
} from "../../../orchestrator/src/safety-verify.js";
import { readExclusiveControlText } from "../../../orchestrator/src/control-file.js";

function fixture(missionId = "mission-under-test", runId = "terminal-verify") {
  const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-mission-receipt-"));
  const missionDir = path.join(workbench, "missions", missionId);
  const runDir = path.join(workbench, "runs", runId);
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(
    path.join(missionDir, "scope-lock.md"),
    `# Scope\n\n## Allowed Workbench\n- \`missions/${missionId}/**\`\n`,
    "utf8",
  );
  ensureMissionSafetyBaseline(workbench, missionId);
  mkdirSync(runDir, { recursive: true });
  const checkpoint = "## VERIFY_REPORT\n- suite: PASS\n";
  writeFileSync(path.join(runDir, "checkpoint.md"), checkpoint, "utf8");
  writeFileSync(
    path.join(runDir, "manifest.json"),
    `${JSON.stringify({ runId, missionId, runKind: "verify" })}\n`,
    "utf8",
  );
  mkdirSync(path.join(workbench, "queue"), { recursive: true });
  writeFileSync(path.join(workbench, "queue", "now.yaml"), "now: []\nbacklog: []\n", "utf8");
  return { workbench, missionId, runId, missionDir, runDir, checkpoint };
}

function agiFixture(repoRoot: string) {
  const missionId = "juno-agi-literature-2026";
  const runId = "juno-ag83-verify";
  const result = fixture(missionId, runId);
  const papersDir = path.join(result.missionDir, "papers");
  mkdirSync(papersDir, { recursive: true });
  writeFileSync(path.join(result.missionDir, "taxonomy-agi.md"), "# AGI taxonomy\n", "utf8");
  writeFileSync(path.join(papersDir, "README.md"), "# Evidence batches\n", "utf8");
  for (let batch = 1; batch <= 40; batch += 1) {
    const records: string[] = [];
    for (let entry = 1; entry <= 25; entry += 1) {
      const key = `${String(batch).padStart(2, "0")}-${String(entry).padStart(2, "0")}`;
      records.push(
        [
          `  - title: "Unique AGI evidence paper ${key}"`,
          "    authors: \"Researcher One and Researcher Two\"",
          "    year: 2024",
          "    venue: \"Evidence Test Venue\"",
          `    url: \"https://example.test/agi/${key}\"`,
          "    one_line: \"A substantive evidence summary with enough detail for validation.\"",
          "    juno_hook: \"A substantive Juno architecture hook with enough detail for validation.\"",
        ].join("\n"),
      );
    }
    writeFileSync(
      path.join(papersDir, `batch-${String(batch).padStart(2, "0")}.yaml`),
      `${records.join("\n")}\n`,
      "utf8",
    );
  }
  mkdirSync(path.join(repoRoot, "wiki"), { recursive: true });
  writeFileSync(
    path.join(repoRoot, "wiki", "juno-agi-north-star.md"),
    `# AGI North Star\n\n## Synthesis\n\n${"substantive synthesis ".repeat(80)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(result.runDir, "manifest.json"),
    `${JSON.stringify({ runId, missionId, runKind: "verify", phaseId: "ag83-verify" })}\n`,
    "utf8",
  );
  return result;
}

function terminalQueueHead(missionId: string, runId: string, phaseId = "terminal-verify") {
  return {
    id: runId,
    horizon: "mission" as const,
    kind: "verify",
    run_kind: "verify" as const,
    repo_target: "workbench",
    mission_id: missionId,
    phase_id: phaseId,
    prompt: "executor_verify",
    provider: "openai_codex" as const,
    max_minutes: 25,
    success_criteria: "terminal evidence passes",
  };
}

describe("mission completion receipts", () => {
  it("uses sha256 mission paths and issues a strict receipt idempotently", () => {
    const { workbench, missionId, runId, checkpoint } = fixture();
    const expectedName = `${createHash("sha256").update(missionId).digest("hex")}.json`;
    expect(path.basename(missionCompletionReceiptPath(workbench, missionId))).toBe(expectedName);

    const first = writeOrdinaryVerifyCompletionReceipt(workbench, missionId, runId);
    const replay = writeOrdinaryVerifyCompletionReceipt(workbench, missionId, runId);
    expect(replay).toEqual(first);
    expect(first.runCheckpointSha256).toBe(
      createHash("sha256").update(checkpoint).digest("hex"),
    );
  });

  it("fails closed on malformed or conflicting immutable evidence", () => {
    const { workbench, missionId, runId, runDir } = fixture();
    const receiptPath = missionCompletionReceiptPath(workbench, missionId);
    mkdirSync(path.dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, "{", "utf8");
    expect(() => readMissionCompletionReceipt(workbench, missionId)).toThrow(/unreadable/);
    expect(() =>
      writeOrdinaryVerifyCompletionReceipt(workbench, missionId, runId),
    ).toThrow(/unreadable/);

    rmSync(receiptPath);
    writeOrdinaryVerifyCompletionReceipt(workbench, missionId, runId);
    writeFileSync(
      path.join(runDir, "checkpoint.md"),
      "## VERIFY_REPORT\n- suite: PASS\n- changed: PASS\n",
      "utf8",
    );
    expect(() =>
      writeOrdinaryVerifyCompletionReceipt(workbench, missionId, runId),
    ).toThrow(/conflicting evidence/);
    expect(() => readMissionCompletionReceipt(workbench, missionId)).toThrow(/no longer matches/);
  });

  it("rejects hard-linked control evidence and bytes that drift during descriptor reads", () => {
    const { workbench, missionId, runId } = fixture();
    writeOrdinaryVerifyCompletionReceipt(workbench, missionId, runId);
    const receiptPath = missionCompletionReceiptPath(workbench, missionId);
    linkSync(receiptPath, `${receiptPath}.alias`);
    expect(() => readMissionCompletionReceipt(workbench, missionId)).toThrow(
      /exclusive regular file/,
    );

    const driftPath = path.join(workbench, "state", "drifting-control.json");
    writeFileSync(driftPath, "{\"state\":1}\n", "utf8");
    expect(() =>
      readExclusiveControlText(driftPath, "Drifting control", 1024, {
        afterRead: () => writeFileSync(driftPath, "{\"state\":200}\n", "utf8"),
      }),
    ).toThrow(/changed while reading|size changed while reading/);
  });

  it("rejects a hard-linked pending completion intent before recovery", () => {
    const { workbench, missionId, runId } = fixture("hardlink-intent", "hardlink-verify");
    const head = terminalQueueHead(missionId, runId);
    saveNowQueue(workbench, [head]);
    const snapshot = readNowQueueSnapshot(workbench);
    prepareOrdinaryVerifyCompletion(workbench, {
      expectedQueueRevision: snapshot.revision,
      expectedHead: head,
    });
    const intentPath = verifyCompletionIntentPath(workbench, missionId);
    linkSync(intentPath, `${intentPath}.alias`);
    expect(() => recoverPendingVerifyCompletions(workbench)).toThrow(/exclusive regular file/);
    expect(parseNowYaml(workbench).now).toEqual([head]);
    expect(readMissionCompletionReceipt(workbench, missionId)).toBeNull();
  });

  it("recovers only its own provable post-link publish aliases", () => {
    const { workbench, missionId, runId } = fixture("publish-crash", "publish-crash-verify");
    const head = terminalQueueHead(missionId, runId);
    saveNowQueue(workbench, [head]);
    const snapshot = readNowQueueSnapshot(workbench);
    prepareOrdinaryVerifyCompletion(workbench, {
      expectedQueueRevision: snapshot.revision,
      expectedHead: head,
    });

    const intentPath = verifyCompletionIntentPath(workbench, missionId);
    const intentTemp = path.join(
      path.dirname(intentPath),
      `.${path.basename(intentPath)}.999.123e4567-e89b-42d3-a456-426614174000.tmp`,
    );
    linkSync(intentPath, intentTemp);
    expect(recoverPendingVerifyCompletions(workbench)).toMatchObject({
      status: "recovered",
      recovered: [{ terminalRunId: runId }],
    });
    expect(existsSync(intentTemp)).toBe(false);

    const receiptPath = missionCompletionReceiptPath(workbench, missionId);
    const receiptTemp = path.join(
      path.dirname(receiptPath),
      `.${path.basename(receiptPath)}.999.123e4567-e89b-42d3-a456-426614174001.tmp`,
    );
    linkSync(receiptPath, receiptTemp);
    expect(readMissionCompletionReceipt(workbench, missionId)?.terminalRunId).toBe(runId);
    expect(existsSync(receiptTemp)).toBe(false);

    const unprovenTemp = path.join(
      path.dirname(receiptPath),
      `.${path.basename(receiptPath)}.998.123e4567-e89b-42d3-a456-426614174002.tmp`,
    );
    writeFileSync(unprovenTemp, "{}\n", "utf8");
    expect(() => readMissionCompletionReceipt(workbench, missionId)).toThrow(/unproven publish temp/);
    rmSync(unprovenTemp);
    expect(readMissionCompletionReceipt(workbench, missionId)?.terminalRunId).toBe(runId);
  });

  it("remains authoritative after the terminal run is purged", () => {
    const { workbench, missionId, runId } = fixture();
    const receipt = writeOrdinaryVerifyCompletionReceipt(workbench, missionId, runId);
    rmSync(path.join(workbench, "runs"), { recursive: true, force: true });
    expect(readMissionCompletionReceipt(workbench, missionId)).toEqual(receipt);
  });

  it("rejects state, runs, and missions roots that escape through directory links", () => {
    const stateCase = fixture("linked-state", "linked-state-verify");
    const stateOutside = path.join(
      mkdtempSync(path.join(os.tmpdir(), "juno-linked-state-")),
      "state",
    );
    renameSync(path.join(stateCase.workbench, "state"), stateOutside);
    symlinkSync(
      stateOutside,
      path.join(stateCase.workbench, "state"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() =>
      writeOrdinaryVerifyCompletionReceipt(
        stateCase.workbench,
        stateCase.missionId,
        stateCase.runId,
      )
    ).toThrow(/state root|canonical containment|non-link directory/);

    const runsCase = fixture("linked-runs", "linked-runs-verify");
    const runsOutside = path.join(
      mkdtempSync(path.join(os.tmpdir(), "juno-linked-runs-")),
      "runs",
    );
    renameSync(path.join(runsCase.workbench, "runs"), runsOutside);
    symlinkSync(
      runsOutside,
      path.join(runsCase.workbench, "runs"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() =>
      writeOrdinaryVerifyCompletionReceipt(
        runsCase.workbench,
        runsCase.missionId,
        runsCase.runId,
      )
    ).toThrow(/runs root|canonical containment|non-link directory/);

    const missionsCase = fixture("linked-missions", "linked-missions-verify");
    writeOrdinaryVerifyCompletionReceipt(
      missionsCase.workbench,
      missionsCase.missionId,
      missionsCase.runId,
    );
    const missionsOutside = path.join(
      mkdtempSync(path.join(os.tmpdir(), "juno-linked-missions-")),
      "missions",
    );
    renameSync(path.join(missionsCase.workbench, "missions"), missionsOutside);
    symlinkSync(
      missionsOutside,
      path.join(missionsCase.workbench, "missions"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() =>
      readMissionCompletionReceipt(missionsCase.workbench, missionsCase.missionId)
    ).toThrow(/missions root|canonical containment|non-link directory/);
  });

  it("rejects the wrong evidence policy and retained run mutation", () => {
    const { workbench, missionId, runId, runDir } = fixture();
    writeOrdinaryVerifyCompletionReceipt(workbench, missionId, runId);
    const receiptPath = missionCompletionReceiptPath(workbench, missionId);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    receipt.evidenceVersion = "agi-literature-v1";
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
    try {
      readMissionCompletionReceipt(workbench, missionId);
      throw new Error("wrong evidence policy was accepted");
    } catch (error) {
      expect((error as Error & { cause?: Error }).cause?.message).toMatch(
        /evidenceVersion mismatch/,
      );
    }

    receipt.evidenceVersion = "ordinary-verify-v1";
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
    writeFileSync(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId, missionId: "other-mission", runKind: "verify" })}\n`,
      "utf8",
    );
    expect(() => readMissionCompletionReceipt(workbench, missionId)).toThrow(/matching terminal verify/);
  });

  it("issues an ordinary receipt only from the final safe verify run", () => {
    const { workbench, missionId, runId, missionDir, runDir } = fixture();
    writeFileSync(
      path.join(missionDir, "scope-lock.md"),
      `# Scope\n\n## Allowed Workbench\n- \`missions/${missionId}/**\`\n`,
      "utf8",
    );
    ensureMissionSafetyBaseline(workbench, missionId);
    writeFileSync(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId, missionId, runKind: "verify" })}\n`,
      "utf8",
    );
    mkdirSync(path.join(workbench, "queue"), { recursive: true });
    writeFileSync(path.join(workbench, "queue", "now.yaml"), "now: []\nbacklog: []\n", "utf8");

    const receipt = writeOrdinaryVerifyCompletionReceipt(workbench, missionId, runId);
    expect(receipt.evidenceVersion).toBe("ordinary-verify-v1");
    expect(readFileSync(missionCompletionReceiptPath(workbench, missionId), "utf8"))
      .toContain(`"terminalRunId": "${runId}"`);
  });

  it("rolls the exact verify head back when receipt commit fails, then recovers without rerun", () => {
    const { workbench, missionId, runId } = fixture();
    const head = terminalQueueHead(missionId, runId);
    saveNowQueue(workbench, [head]);
    const snapshot = readNowQueueSnapshot(workbench);
    const completionDirectory = path.join(workbench, "state", "mission-completions");
    writeFileSync(completionDirectory, "block directory creation\n", "utf8");

    const failed = finalizeOrdinaryVerifyQueueHead(workbench, {
      expectedQueueRevision: snapshot.revision,
      expectedHead: head,
    });
    expect(failed).toMatchObject({ ok: false, reason: "commit_failed", restored: true });
    expect(parseNowYaml(workbench).now).toEqual([head]);
    expect(() => readMissionCompletionReceipt(workbench, missionId)).toThrow(/regular directory/);
    expect(readFileSync(verifyCompletionIntentPath(workbench, missionId), "utf8"))
      .toContain(`"terminalRunId": "${runId}"`);

    rmSync(completionDirectory);
    expect(readMissionCompletionReceipt(workbench, missionId)).toBeNull();
    const recovered = recoverPendingVerifyCompletions(workbench);
    expect(recovered).toMatchObject({
      status: "recovered",
      recovered: [{ terminalRunId: runId, mode: "dequeued_head" }],
    });
    expect(parseNowYaml(workbench).now).toEqual([]);
    expect(readMissionCompletionReceipt(workbench, missionId)?.terminalRunId).toBe(runId);
    expect(existsSync(verifyCompletionIntentPath(workbench, missionId))).toBe(false);
  });

  it("converges after crashes on either side of dequeue and preserves foreign queue work", () => {
    const before = fixture("mission-before-dequeue", "verify-before-dequeue");
    const beforeHead = terminalQueueHead(before.missionId, before.runId);
    saveNowQueue(before.workbench, [beforeHead]);
    const beforeSnapshot = readNowQueueSnapshot(before.workbench);
    prepareOrdinaryVerifyCompletion(before.workbench, {
      expectedQueueRevision: beforeSnapshot.revision,
      expectedHead: beforeHead,
    });
    expect(recoverPendingVerifyCompletions(before.workbench).status).toBe("recovered");
    expect(parseNowYaml(before.workbench).now).toEqual([]);
    expect(readMissionCompletionReceipt(before.workbench, before.missionId)).not.toBeNull();

    const after = fixture("mission-after-dequeue", "verify-after-dequeue");
    const afterHead = terminalQueueHead(after.missionId, after.runId);
    saveNowQueue(after.workbench, [afterHead]);
    const afterSnapshot = readNowQueueSnapshot(after.workbench);
    prepareOrdinaryVerifyCompletion(after.workbench, {
      expectedQueueRevision: afterSnapshot.revision,
      expectedHead: afterHead,
    });
    const dequeued = replaceQueueHeadConditional(after.workbench, {
      expectedRevision: afterSnapshot.revision,
      expectedHead: afterHead,
      replacement: [],
    });
    expect(dequeued.ok).toBe(true);
    const foreign = {
      id: "foreign-writer-item",
      horizon: "day" as const,
      kind: "task",
      prompt: "executor_generic",
    };
    saveNowQueue(after.workbench, [foreign]);
    const completionDirectory = path.join(after.workbench, "state", "mission-completions");
    writeFileSync(completionDirectory, "block directory creation\n", "utf8");

    const failedRecovery = recoverPendingVerifyCompletions(after.workbench);
    expect(failedRecovery).toMatchObject({ status: "blocked" });
    expect(parseNowYaml(after.workbench).now).toEqual([afterHead, foreign]);
    expect(readFileSync(path.join(after.workbench, "queue", "now.yaml"), "utf8"))
      .toContain("foreign-writer-item");

    rmSync(completionDirectory);
    expect(recoverPendingVerifyCompletions(after.workbench).status).toBe("recovered");
    expect(parseNowYaml(after.workbench).now).toEqual([foreign]);
    expect(readMissionCompletionReceipt(after.workbench, after.missionId)).not.toBeNull();
  });

  it("rebases one CAS when an immutable intent sees the same head at a new revision", () => {
    const { workbench, missionId, runId } = fixture("intent-rebase", "intent-rebase-verify");
    const head = terminalQueueHead(missionId, runId);
    saveNowQueue(workbench, [head]);
    const preparedAt = readNowQueueSnapshot(workbench);
    prepareOrdinaryVerifyCompletion(workbench, {
      expectedQueueRevision: preparedAt.revision,
      expectedHead: head,
    });
    const foreign = {
      id: "foreign-backlog-after-intent",
      horizon: "day" as const,
      kind: "task",
      prompt: "executor_generic",
    };
    saveNowQueue(workbench, [head], [foreign]);
    const current = readNowQueueSnapshot(workbench);

    const result = finalizeOrdinaryVerifyQueueHead(workbench, {
      expectedQueueRevision: current.revision,
      expectedHead: head,
    });
    expect(result.ok).toBe(true);
    expect(parseNowYaml(workbench)).toMatchObject({ now: [], backlog: [foreign] });
    expect(readMissionCompletionReceipt(workbench, missionId)?.terminalRunId).toBe(runId);
  });

  it("fails public receipt reads closed on re-queued work but lets a bound intent reconcile", () => {
    const { workbench, missionId, runId } = fixture("receipt-requeue", "receipt-requeue-verify");
    const head = terminalQueueHead(missionId, runId);
    saveNowQueue(workbench, [head]);
    const snapshot = readNowQueueSnapshot(workbench);
    prepareOrdinaryVerifyCompletion(workbench, {
      expectedQueueRevision: snapshot.revision,
      expectedHead: head,
    });
    const intentPath = verifyCompletionIntentPath(workbench, missionId);
    const intentRaw = readFileSync(intentPath, "utf8");
    expect(finalizeOrdinaryVerifyQueueHead(workbench, {
      expectedQueueRevision: snapshot.revision,
      expectedHead: head,
    }).ok).toBe(true);

    writeFileSync(intentPath, intentRaw, { encoding: "utf8", flag: "wx" });
    saveNowQueue(workbench, [head]);
    expect(() => readMissionCompletionReceipt(workbench, missionId)).toThrow(/still has queued work/);
    expect(recoverPendingVerifyCompletions(workbench)).toMatchObject({
      status: "recovered",
      recovered: [{ terminalRunId: runId, mode: "dequeued_head" }],
    });
    expect(readMissionCompletionReceipt(workbench, missionId)?.terminalRunId).toBe(runId);
  });

  it("uses the same dequeue transaction for specialized terminal evidence", () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "juno-specialized-transaction-repo-"));
    const oldRoot = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId, runId } = agiFixture(repoRoot);
      const head = terminalQueueHead(missionId, runId, "ag83-verify");
      saveNowQueue(workbench, [head]);
      const snapshot = readNowQueueSnapshot(workbench);
      const result = finalizeSpecializedVerifyQueueHead(workbench, {
        expectedQueueRevision: snapshot.revision,
        expectedHead: head,
        missionCheckpointText: "# Mission\n\nSTATUS: COMPLETE\n",
      });
      expect(result.ok).toBe(true);
      expect(parseNowYaml(workbench).now).toEqual([]);
      expect(readMissionCompletionReceipt(workbench, missionId)?.evidenceVersion)
        .toBe("agi-literature-v1");
    } finally {
      if (oldRoot === undefined) delete process.env.JUNO_OVERSIGHT_ROOT;
      else process.env.JUNO_OVERSIGHT_ROOT = oldRoot;
    }
  });

  it("preserves a foreign specialized mission checkpoint after intent preparation", () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "juno-specialized-checkpoint-race-"));
    const oldRoot = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId, runId, missionDir } = agiFixture(repoRoot);
      const head = terminalQueueHead(missionId, runId, "ag83-verify");
      saveNowQueue(workbench, [head]);
      const snapshot = readNowQueueSnapshot(workbench);
      prepareSpecializedVerifyCompletion(workbench, {
        expectedQueueRevision: snapshot.revision,
        expectedHead: head,
        missionCheckpointText: "# Mission\n\nSTATUS: COMPLETE\n",
      });
      const intentPath = verifyCompletionIntentPath(workbench, missionId);
      const intentSha256 = createHash("sha256").update(readFileSync(intentPath)).digest("hex");
      const missionCheckpointPath = path.join(missionDir, "checkpoint.md");
      writeFileSync(missionCheckpointPath, "foreign checkpoint\n", "utf8");
      rmSync(missionSafetyBaselinePath(workbench, missionId));
      ensureMissionSafetyBaseline(workbench, missionId);

      const recovery = recoverExactPendingVerifyCompletion(
        workbench,
        missionId,
        intentSha256,
      );
      expect(recovery).toMatchObject({ status: "blocked" });
      expect(recovery.reason).toMatch(/checkpoint/i);
      expect(readFileSync(missionCheckpointPath, "utf8")).toBe("foreign checkpoint\n");
      expect(parseNowYaml(workbench).now[0]?.id).toBe(runId);
      expect(existsSync(missionCompletionReceiptPath(workbench, missionId))).toBe(false);
    } finally {
      if (oldRoot === undefined) delete process.env.JUNO_OVERSIGHT_ROOT;
      else process.env.JUNO_OVERSIGHT_ROOT = oldRoot;
    }
  });

  it("refuses ordinary signing while mission work remains or for specialized missions", () => {
    const { workbench, missionId, runId, missionDir, runDir } = fixture();
    writeFileSync(
      path.join(missionDir, "scope-lock.md"),
      `# Scope\n\n## Allowed Workbench\n- \`missions/${missionId}/**\`\n`,
      "utf8",
    );
    ensureMissionSafetyBaseline(workbench, missionId);
    writeFileSync(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId, missionId, runKind: "verify" })}\n`,
      "utf8",
    );
    mkdirSync(path.join(workbench, "queue"), { recursive: true });
    writeFileSync(
      path.join(workbench, "queue", "now.yaml"),
      `now:\n  - id: later\n    mission_id: ${missionId}\nbacklog: []\n`,
      "utf8",
    );
    expect(() => writeOrdinaryVerifyCompletionReceipt(workbench, missionId, runId))
      .toThrow(/queued work/);

    const specialized = fixture("juno-agi-literature-2026", "juno-ag83-verify");
    expect(() =>
      writeOrdinaryVerifyCompletionReceipt(
        specialized.workbench,
        specialized.missionId,
        specialized.runId,
      ),
    ).toThrow(/domain completion evidence/);
  });

  it("signs specialized completion only after safety, domain, terminal phase, and queue gates", () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "juno-specialized-repo-"));
    const oldRoot = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId, runId, missionDir } = agiFixture(repoRoot);
      const missionCheckpoint = "# Mission\n\nSTATUS: COMPLETE\n";
      const outside = path.join(workbench, "missions", "outside", "changed.md");
      mkdirSync(path.dirname(outside), { recursive: true });
      writeFileSync(outside, "out of scope\n", "utf8");
      expect(() =>
        writeSpecializedVerifyCompletionReceipt(
          workbench,
          missionId,
          runId,
          missionCheckpoint,
        ),
      ).toThrow(/safety report/);
      rmSync(path.dirname(outside), { recursive: true, force: true });

      writeFileSync(
        path.join(workbench, "queue", "now.yaml"),
        `now:\n  - id: later\n    horizon: mission\n    kind: verify\n    run_kind: verify\n    mission_id: ${missionId}\n    phase_id: later-verify\n    prompt: executor_verify\nbacklog: []\n`,
        "utf8",
      );
      expect(() =>
        writeSpecializedVerifyCompletionReceipt(
          workbench,
          missionId,
          runId,
          missionCheckpoint,
        ),
      ).toThrow(/queued work/);
      writeFileSync(path.join(workbench, "queue", "now.yaml"), "now: []\nbacklog: []\n", "utf8");

      const receipt = writeSpecializedVerifyCompletionReceipt(
        workbench,
        missionId,
        runId,
        missionCheckpoint,
      );
      expect(receipt.evidenceVersion).toBe("agi-literature-v1");
      expect(readFileSync(path.join(missionDir, "checkpoint.md"), "utf8"))
        .toBe(missionCheckpoint);
      expect(readMissionCompletionReceipt(workbench, missionId)).toEqual(receipt);
    } finally {
      if (oldRoot === undefined) delete process.env.JUNO_OVERSIGHT_ROOT;
      else process.env.JUNO_OVERSIGHT_ROOT = oldRoot;
    }
  });
});
