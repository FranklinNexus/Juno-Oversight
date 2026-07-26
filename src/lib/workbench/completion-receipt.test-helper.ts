import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MISSION_COMPLETION_RECEIPT_VERSION,
  ORDINARY_VERIFY_EVIDENCE_VERSION,
  missionCompletionReceiptPath,
} from "../../../orchestrator/src/mission-completion.js";

const SPECIALIZED = new Map([
  ["juno-agi-literature-2026", { evidenceVersion: "agi-literature-v1", phaseId: "ag83-verify" }],
  ["juno-axiom-book-2026", { evidenceVersion: "axiom-book-v1", phaseId: "ax46-verify" }],
]);

/** Test-only fixture for consumers that only need to read an already trusted receipt. */
export function writeTrustedCompletionReceiptFixture(
  workbench: string,
  missionId: string,
): string {
  const policy = SPECIALIZED.get(missionId);
  const runId = `${missionId}-terminal-verify`;
  const missionDir = path.join(workbench, "missions", missionId);
  const runDir = path.join(workbench, "runs", runId);
  mkdirSync(missionDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const checkpoint = "## VERIFY_REPORT\n- fixture: PASS\n";
  writeFileSync(path.join(runDir, "checkpoint.md"), checkpoint, "utf8");
  writeFileSync(
    path.join(runDir, "manifest.json"),
    `${JSON.stringify({
      runId,
      missionId,
      runKind: "verify",
      ...(policy ? { phaseId: policy.phaseId } : {}),
    })}\n`,
    "utf8",
  );
  const receiptPath = missionCompletionReceiptPath(workbench, missionId);
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(
    receiptPath,
    `${JSON.stringify({
      receiptVersion: MISSION_COMPLETION_RECEIPT_VERSION,
      missionId,
      terminalRunId: runId,
      runCheckpointSha256: createHash("sha256").update(checkpoint).digest("hex"),
      evidenceVersion: policy?.evidenceVersion ?? ORDINARY_VERIFY_EVIDENCE_VERSION,
      completedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
  return runId;
}
