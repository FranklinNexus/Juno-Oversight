import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunManifest } from "./types.js";
import type { VerifyStep } from "./eval-profile.js";

export const EXECUTION_ARTIFACT_VERSION = 2 as const;

export interface ExecutionAttemptBinding {
  attemptId: string;
  slotIndex: number;
  retryCount: number;
}

export function evidenceSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonicalManifestText(manifest: RunManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function manifestEvidenceSha256(manifest: RunManifest): string {
  return evidenceSha256(canonicalManifestText(manifest));
}

export function executionAttemptBinding(
  runId: string,
  slotIndex: number,
  retryCount: number,
): ExecutionAttemptBinding {
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 1) {
    throw new Error("Execution attempt slotIndex must be a positive integer");
  }
  if (!Number.isSafeInteger(retryCount) || retryCount < 0 || retryCount > 20) {
    throw new Error("Execution attempt retryCount must be an integer between 0 and 20");
  }
  return {
    attemptId: evidenceSha256(`${runId}\n${slotIndex}\n${retryCount}\n`),
    slotIndex,
    retryCount,
  };
}

export function verifyStepId(step: VerifyStep): string {
  return evidenceSha256(JSON.stringify({
    label: step.label,
    cmd: step.cmd,
    args: step.args,
    optional: step.optional === true,
  }));
}

function checkpointSha256(runDir: string): string | null {
  const checkpoint = path.join(runDir, "checkpoint.md");
  try {
    return existsSync(checkpoint) ? evidenceSha256(readFileSync(checkpoint, "utf8")) : null;
  } catch {
    return null;
  }
}

function atomicReplaceText(target: string, text: string): void {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: "utf8", flag: "wx" });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Rewrite or create terminal failure evidence after spawn-level settlement errors. */
export function finalizeExecutionFailureArtifact(
  manifest: RunManifest,
  runDir: string,
  attempt: ExecutionAttemptBinding,
  failure: string,
): void {
  const verify = manifest.runKind === "verify";
  const artifactPath = path.join(runDir, verify ? "verify-artifact.json" : "codex-artifact.json");
  const eventsPath = path.join(runDir, "events.jsonl");
  const eventsText = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
  const common = {
    version: EXECUTION_ARTIFACT_VERSION,
    runId: manifest.runId,
    ...attempt,
    ok: false,
    failure,
    manifestSha256: manifestEvidenceSha256(manifest),
    checkpointSha256: checkpointSha256(runDir),
    eventsSha256: evidenceSha256(eventsText),
  };
  const artifact = verify
    ? {
        profile: manifest.evalProfile ?? "code",
        cwd: manifest.cwd,
        verifiedAt: new Date().toISOString(),
        terminationConfirmed: true,
        steps: [],
        ...common,
      }
    : {
        threadId: null,
        model: manifest.model ?? "default",
        completedAt: new Date().toISOString(),
        usage: null,
        ...common,
      };
  atomicReplaceText(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
}
