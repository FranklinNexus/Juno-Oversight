import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyOperatorRecovery,
  inspectOperatorRecovery,
  type ApplyOperatorRecoveryInput,
} from "../../../orchestrator/src/operator-recovery.js";
import {
  missionCompletionReceiptPath,
  prepareOrdinaryVerifyCompletion,
  readMissionCompletionReceipt,
  recoverExactPendingVerifyCompletion,
  verifyCompletionIntentPath,
} from "../../../orchestrator/src/mission-completion.js";
import {
  parseNowYaml,
  readNowQueueSnapshot,
  saveNowQueue,
} from "../../../orchestrator/src/queue-io.js";
import { ensureMissionSafetyBaseline } from "../../../orchestrator/src/safety-verify.js";

const UUID_A = "123e4567-e89b-42d3-a456-426614174000";
const UUID_B = "123e4567-e89b-42d3-a456-426614174001";

function terminalHead(missionId: string, runId: string) {
  return {
    id: runId,
    horizon: "mission" as const,
    kind: "verify",
    run_kind: "verify" as const,
    repo_target: "workbench",
    mission_id: missionId,
    phase_id: "terminal-verify",
    prompt: "executor_verify",
    provider: "openai_codex" as const,
    max_minutes: 25,
    success_criteria: "terminal evidence passes",
  };
}

function installMissionEvidence(workbench: string, missionId: string, runId: string): void {
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
  writeFileSync(path.join(runDir, "checkpoint.md"), "## VERIFY_REPORT\n- suite: PASS\n", "utf8");
  writeFileSync(
    path.join(runDir, "manifest.json"),
    `${JSON.stringify({ runId, missionId, runKind: "verify" })}\n`,
    "utf8",
  );
}

function preparedFixture(
  missionId = "operator-recovery-mission",
  runId = "operator-recovery-verify",
) {
  const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-operator-recovery-"));
  installMissionEvidence(workbench, missionId, runId);
  const head = terminalHead(missionId, runId);
  saveNowQueue(workbench, [head]);
  const queue = readNowQueueSnapshot(workbench);
  prepareOrdinaryVerifyCompletion(workbench, {
    expectedQueueRevision: queue.revision,
    expectedHead: head,
  });
  return { workbench, missionId, runId, head };
}

function recoveryRequest(workbench: string, reason = "Resume verified completion evidence") {
  const inventory = inspectOperatorRecovery(workbench);
  const incident = inventory.incidents.find(
    (candidate) => candidate.kind === "completion_pending_intent",
  );
  if (!incident) throw new Error("pending completion incident was not discovered");
  return {
    inventory,
    incident,
    input: {
      incidentId: incident.incidentId,
      action: "resume_exact_intent" as const,
      preconditionSha256: incident.preconditionSha256,
      reason,
    },
  };
}

function operationIdFor(input: ApplyOperatorRecoveryInput): string {
  const canonical = JSON.stringify({
    action: input.action,
    incidentId: input.incidentId,
    journalVersion: 1,
    preconditionSha256: input.preconditionSha256,
    reason: input.reason,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

describe("operator recovery inventory", () => {
  it("enumerates queue, selection, and completion recovery artifacts as blocking", () => {
    const { workbench } = preparedFixture("inventory-mission", "inventory-verify");
    const queuePath = path.join(workbench, "queue", "now.yaml");
    writeFileSync(
      `${queuePath}.preimage-999-${UUID_A}`,
      readFileSync(queuePath),
    );
    writeFileSync(
      path.join(workbench, "queue", `.now.yaml.999.${UUID_B}.tmp`),
      readFileSync(queuePath),
    );
    const state = path.join(workbench, "state");
    writeFileSync(
      path.join(state, `workflow-selection.json.preimage-999-${UUID_A}`),
      "{}\n",
      "utf8",
    );
    writeFileSync(
      path.join(state, `workflow-selection.json.rollback-999-${UUID_B}`),
      "{}\n",
      "utf8",
    );
    writeFileSync(
      path.join(state, `.workflow-selection.json.999.${UUID_A}.tmp`),
      "{}\n",
      "utf8",
    );
    const transactions = path.join(state, "mission-completion-transactions");
    writeFileSync(path.join(transactions, `.${"a".repeat(64)}.json.999.${UUID_A}.tmp`), "{}\n");
    writeFileSync(path.join(transactions, "unexpected.control"), "foreign\n");

    const inventory = inspectOperatorRecovery(workbench);
    const kinds = new Set(inventory.incidents.map((incident) => incident.kind));
    expect(kinds.has("queue_preimage")).toBe(true);
    expect(kinds.has("queue_publish_temp")).toBe(true);
    expect(kinds.has("workflow_selection_preimage")).toBe(true);
    expect(kinds.has("workflow_selection_rollback")).toBe(true);
    expect(kinds.has("workflow_selection_publish_temp")).toBe(true);
    expect(kinds.has("completion_publish_temp")).toBe(true);
    expect(kinds.has("completion_unknown_transaction_entry")).toBe(true);
    expect(inventory.incidents.every((incident) => incident.blocking)).toBe(true);
    expect(inventory.incidents.flatMap((incident) => incident.allowedActions)).toEqual([]);
  });

  it("reports missing and malformed canonical queue controls explicitly", () => {
    const missing = mkdtempSync(path.join(os.tmpdir(), "juno-operator-missing-queue-"));
    expect(inspectOperatorRecovery(missing).incidents).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "queue_missing_control" })]),
    );

    const malformed = mkdtempSync(path.join(os.tmpdir(), "juno-operator-invalid-queue-"));
    mkdirSync(path.join(malformed, "queue"));
    writeFileSync(path.join(malformed, "queue", "now.yaml"), "now: [\n", "utf8");
    expect(inspectOperatorRecovery(malformed).incidents).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "queue_invalid_control" })]),
    );
  });

  it("is side-effect free and never cleans a provable completion publish alias", () => {
    const { workbench, missionId } = preparedFixture("alias-mission", "alias-verify");
    const intentPath = verifyCompletionIntentPath(workbench, missionId);
    const alias = path.join(
      path.dirname(intentPath),
      `.${path.basename(intentPath)}.999.${UUID_A}.tmp`,
    );
    linkSync(intentPath, alias);

    const inventory = inspectOperatorRecovery(workbench);
    const intent = inventory.incidents.find((incident) =>
      incident.artifact.relativePath.endsWith(`${path.basename(intentPath)}`)
    );
    expect(intent).toMatchObject({
      kind: "completion_invalid_intent",
      confidence: "invalid",
      allowedActions: [],
    });
    expect(existsSync(intentPath)).toBe(true);
    expect(existsSync(alias)).toBe(true);
  });
});

describe("operator recovery apply", () => {
  it("recovers exactly one intent, persists the reason, and replays idempotently", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-operator-exact-"));
    installMissionEvidence(workbench, "first-mission", "first-verify");
    const firstHead = terminalHead("first-mission", "first-verify");
    saveNowQueue(workbench, [firstHead]);
    prepareOrdinaryVerifyCompletion(workbench, {
      expectedQueueRevision: readNowQueueSnapshot(workbench).revision,
      expectedHead: firstHead,
    });
    installMissionEvidence(workbench, "second-mission", "second-verify");
    const secondHead = terminalHead("second-mission", "second-verify");
    const foreignBacklog = {
      id: "foreign-backlog",
      horizon: "day" as const,
      kind: "task",
      prompt: "executor_generic",
    };
    saveNowQueue(workbench, [secondHead], [foreignBacklog]);
    prepareOrdinaryVerifyCompletion(workbench, {
      expectedQueueRevision: readNowQueueSnapshot(workbench).revision,
      expectedHead: secondHead,
    });
    const inventory = inspectOperatorRecovery(workbench);
    const incident = inventory.incidents.find(
      (candidate) => candidate.completionBinding?.missionId === "second-mission",
    );
    if (!incident) throw new Error("second completion incident was not discovered");
    const input = {
      incidentId: incident.incidentId,
      action: "resume_exact_intent" as const,
      preconditionSha256: incident.preconditionSha256,
      reason: "Resume only the selected second mission",
    };

    const first = applyOperatorRecovery(workbench, input);
    expect(first.recovery).toMatchObject({
      status: "recovered",
      recovered: [{ missionId: "second-mission" }],
    });
    expect(parseNowYaml(workbench)).toMatchObject({ now: [], backlog: [foreignBacklog] });
    expect(readMissionCompletionReceipt(workbench, "second-mission")).not.toBeNull();
    expect(readMissionCompletionReceipt(workbench, "first-mission")).toBeNull();
    expect(existsSync(verifyCompletionIntentPath(workbench, "first-mission"))).toBe(true);

    const journalRoot = path.join(workbench, "state", "operator-recovery", "v1");
    const intentPath = path.join(journalRoot, `${first.operationId}.intent.json`);
    const receiptPath = path.join(journalRoot, `${first.operationId}.receipt.json`);
    expect(readFileSync(intentPath, "utf8")).toContain(input.reason);
    expect(readFileSync(receiptPath, "utf8")).toContain(`"operationId": "${first.operationId}"`);
    expect(applyOperatorRecovery(workbench, input)).toEqual(first);
  });

  it("rejects stale inventory before journaling and preserves the exact queue head", () => {
    const { workbench, head } = preparedFixture("stale-mission", "stale-verify");
    const { input } = recoveryRequest(workbench);
    const queuePath = path.join(workbench, "queue", "now.yaml");
    writeFileSync(`${queuePath}.preimage-999-${UUID_A}`, readFileSync(queuePath));

    expect(() => applyOperatorRecovery(workbench, input)).toThrow(/inventory changed/i);
    expect(readFileSync(queuePath, "utf8")).toContain(head.id);
    expect(existsSync(missionCompletionReceiptPath(workbench, "stale-mission"))).toBe(false);
    const operationId = operationIdFor(input);
    expect(existsSync(
      path.join(workbench, "state", "operator-recovery", "v1", `${operationId}.intent.json`),
    )).toBe(false);
    expect(existsSync(path.join(workbench, "state", "operator-recovery"))).toBe(false);
  });

  it("does not resume a prepared journal after unrelated inventory drift", () => {
    const { workbench, missionId, head } = preparedFixture(
      "journal-drift-mission",
      "journal-drift-verify",
    );
    const { incident, input } = recoveryRequest(workbench, "Reject drift after journal prepare");
    if (!incident.completionBinding) throw new Error("completion binding was not discovered");
    const operationId = operationIdFor(input);
    const journalRoot = path.join(workbench, "state", "operator-recovery", "v1");
    mkdirSync(journalRoot, { recursive: true });
    writeFileSync(
      path.join(journalRoot, `${operationId}.intent.json`),
      `${JSON.stringify({
        journalVersion: 1,
        recordKind: "operator-recovery-intent",
        operationId,
        incidentId: input.incidentId,
        action: input.action,
        preconditionSha256: input.preconditionSha256,
        reason: input.reason,
        completionBinding: incident.completionBinding,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8",
    );
    const queuePath = path.join(workbench, "queue", "now.yaml");
    writeFileSync(`${queuePath}.preimage-999-${UUID_A}`, readFileSync(queuePath));

    expect(() => applyOperatorRecovery(workbench, input)).toThrow(/inventory changed/i);
    expect(readFileSync(queuePath, "utf8")).toContain(head.id);
    expect(existsSync(missionCompletionReceiptPath(workbench, missionId))).toBe(false);
    expect(existsSync(
      path.join(journalRoot, `${operationId}.receipt.json`),
    )).toBe(false);
  });

  it("finishes a journal whose recovery committed before its receipt was published", () => {
    const { workbench, missionId } = preparedFixture("crash-mission", "crash-verify");
    const { incident, input } = recoveryRequest(workbench, "Resume after receipt publish crash");
    if (!incident.completionBinding) throw new Error("completion binding was not discovered");
    const operationId = operationIdFor(input);
    const journalRoot = path.join(workbench, "state", "operator-recovery", "v1");
    mkdirSync(journalRoot, { recursive: true });
    writeFileSync(
      path.join(journalRoot, `${operationId}.intent.json`),
      `${JSON.stringify({
        journalVersion: 1,
        recordKind: "operator-recovery-intent",
        operationId,
        incidentId: input.incidentId,
        action: input.action,
        preconditionSha256: input.preconditionSha256,
        reason: input.reason,
        completionBinding: incident.completionBinding,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8",
    );
    const activeIntentPath = verifyCompletionIntentPath(workbench, missionId);
    const activeIntentRaw = readFileSync(activeIntentPath, "utf8");
    expect(recoverExactPendingVerifyCompletion(
      workbench,
      missionId,
      incident.completionBinding.intentSha256,
    ).status).toBe("recovered");
    writeFileSync(activeIntentPath, activeIntentRaw, { encoding: "utf8", flag: "wx" });

    const resumed = applyOperatorRecovery(workbench, input);
    expect(resumed).toMatchObject({
      operationId,
      recovery: {
        status: "recovered",
        recovered: [{ missionId, mode: "head_already_absent" }],
      },
    });
    expect(existsSync(path.join(journalRoot, `${operationId}.receipt.json`))).toBe(true);
    expect(existsSync(activeIntentPath)).toBe(false);
  });

  it("rejects a syntactically valid recovered journal receipt without live completion proof", () => {
    const { workbench, missionId, runId } = preparedFixture(
      "forged-receipt-mission",
      "forged-receipt-verify",
    );
    const { incident, input } = recoveryRequest(workbench, "Reject forged recovered receipt");
    if (!incident.completionBinding) throw new Error("completion binding was not discovered");
    const operationId = operationIdFor(input);
    const journalRoot = path.join(workbench, "state", "operator-recovery", "v1");
    mkdirSync(journalRoot, { recursive: true });
    const intentRaw = `${JSON.stringify({
      journalVersion: 1,
      recordKind: "operator-recovery-intent",
      operationId,
      incidentId: input.incidentId,
      action: input.action,
      preconditionSha256: input.preconditionSha256,
      reason: input.reason,
      completionBinding: incident.completionBinding,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`;
    writeFileSync(path.join(journalRoot, `${operationId}.intent.json`), intentRaw, "utf8");
    writeFileSync(
      path.join(journalRoot, `${operationId}.receipt.json`),
      `${JSON.stringify({
        journalVersion: 1,
        recordKind: "operator-recovery-receipt",
        operationId,
        intentSha256: createHash("sha256").update(intentRaw).digest("hex"),
        recovery: {
          status: "recovered",
          recovered: [{ missionId, terminalRunId: runId, mode: "dequeued_head" }],
        },
        completedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8",
    );

    expect(() => applyOperatorRecovery(workbench, input)).toThrow(/live completion evidence/i);
    expect(parseNowYaml(workbench).now[0]?.id).toBe(runId);
    expect(readMissionCompletionReceipt(workbench, missionId)).toBeNull();
    expect(existsSync(verifyCompletionIntentPath(workbench, missionId))).toBe(true);
  });

  it("rejects foreign journal bytes, force fields, and invalid reasons", () => {
    const { workbench } = preparedFixture("journal-mission", "journal-verify");
    const { input } = recoveryRequest(workbench, "Journal conflict test");
    const operationId = operationIdFor(input);
    const journalRoot = path.join(workbench, "state", "operator-recovery", "v1");
    mkdirSync(journalRoot, { recursive: true });
    writeFileSync(path.join(journalRoot, `${operationId}.intent.json`), "{}\n", "utf8");
    expect(() => applyOperatorRecovery(workbench, input)).toThrow(/journal intent|missing or unknown/i);
    expect(parseNowYaml(workbench).now).toHaveLength(1);

    expect(() => applyOperatorRecovery(workbench, {
      ...input,
      force: true,
    } as ApplyOperatorRecoveryInput)).toThrow(/unknown fields/i);
    expect(() => applyOperatorRecovery(workbench, {
      ...input,
      reason: " leading whitespace",
    })).toThrow(/reason/i);
  });
});
