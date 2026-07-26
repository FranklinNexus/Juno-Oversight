import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  isReviewPass,
  parseReviewVerdict,
  resolveQueueAdvance,
  type QueueAdvanceAction,
} from "./review-loop.js";
import { hasUniqueCompleteStatus } from "./checkpoint-status.js";
import { formatSafetyVerifyMarkdown, runMissionDiffSafetyVerify } from "./safety-verify.js";
import {
  MAX_REVISION_ATTEMPTS,
  assertRevisionAttempt,
  revisionFixRunId,
} from "./revision-lineage.js";
import type { QueueItem, RunKind } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;

export interface WorkflowExperimentRevisionPromptBinding {
  experimentId: string;
  promptSha256ByTemplate: Readonly<Record<string, string>>;
}

export function readCheckpoint(workbench: string, runId: string): string {
  const cp = path.join(workbench, "runs", runId, "checkpoint.md");
  try {
    return readFileSync(cp, "utf8");
  } catch {
    return "";
  }
}

export function checkpointTextForAdvance(
  workbench: string,
  runId: string,
  missionId?: string,
): string {
  void missionId;
  return readCheckpoint(workbench, runId);
}

/** Run checkpoint still at materialize stub (no gate markers). */
export function isRunCheckpointStub(checkpointText: string): boolean {
  return !(
    /##\s*VERIFY_REPORT|REVIEW_VERDICT/i.test(checkpointText)
    || hasUniqueCompleteStatus(checkpointText)
  );
}

/**
 * Mission checkpoints are shared across runs and cannot prove that this run completed.
 * Keep this compatibility hook inert so callers only gate on runs/<id>/checkpoint.md.
 */
export function finalizeRunCheckpoint(
  workbench: string,
  runId: string,
  missionId: string | undefined,
  runKind: RunKind,
): boolean {
  void workbench;
  void runId;
  void missionId;
  void runKind;
  return false;
}

export function readRunKind(workbench: string, runId: string): RunKind {
  const manifestPath = path.join(workbench, "runs", runId, "manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { runKind?: RunKind };
    if (manifest.runKind) return manifest.runKind;
  } catch {
    // fall through
  }

  const queueItemPath = path.join(workbench, "runs", runId, "queue-item.json");
  try {
    const item = JSON.parse(readFileSync(queueItemPath, "utf8")) as {
      run_kind?: RunKind;
      kind?: string;
    };
    if (item.run_kind) return item.run_kind;
    if (item.kind === "review") return "review";
    if (item.kind === "debate") return "debate";
    if (item.kind === "verify") return "verify";
  } catch {
    // fall through
  }

  return "implement";
}

function readManifestMissionId(workbench: string, runId: string): string | undefined {
  const manifestPath = path.join(workbench, "runs", runId, "manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { missionId?: unknown };
    return typeof manifest.missionId === "string" && manifest.missionId.trim()
      ? manifest.missionId
      : undefined;
  } catch {
    return undefined;
  }
}

export function evaluateCompletedRun(
  workbench: string,
  runId: string,
  missionId?: string,
): QueueAdvanceAction {
  const checkpoint = checkpointTextForAdvance(workbench, runId, missionId);
  const runKind = readRunKind(workbench, runId);
  const manifestMissionId = readManifestMissionId(workbench, runId);
  if (missionId && manifestMissionId && missionId !== manifestMissionId) {
    return { action: "block" };
  }
  const effectiveMissionId = missionId ?? manifestMissionId;
  if ((runKind === "implement" || runKind === "verify") && effectiveMissionId) {
    const safety = runMissionDiffSafetyVerify(workbench, effectiveMissionId);
    const safetyPath = path.join(workbench, "runs", runId, "safety-verify.md");
    writeFileSync(safetyPath, `${formatSafetyVerifyMarkdown(safety)}\n`, "utf8");
    if (!safety.ok) return { action: "block" };
  }
  return resolveQueueAdvance(runKind, checkpoint);
}

/** Whether a completed slot should flip progress.md phase row to `done`. */
export function shouldMarkPhaseDone(runKind: RunKind, checkpointText: string): boolean {
  return resolveQueueAdvance(runKind, checkpointText).action === "dequeue";
}

export function markMissionPhaseDone(
  workbench: string,
  missionId: string,
  phaseId: string,
): boolean {
  const phaseKeys = progressPhaseKeys(phaseId);
  const missionIds = progressMissionIds(missionId, phaseId);

  for (const mid of missionIds) {
    for (const key of phaseKeys) {
      if (markProgressRow(workbench, mid, key)) return true;
    }
  }
  return false;
}

/** Map bq-ch16-revise → ch16 for book-quality progress tables. */
function progressPhaseKeys(phaseId: string): string[] {
  const keys = [phaseId];
  const m = phaseId.match(/(?:bq-)?ch(\d{2})/i);
  if (m) keys.push(`ch${m[1]}`, `bq-ch${m[1]}`);
  return [...new Set(keys)];
}

function progressMissionIds(missionId: string, phaseId: string): string[] {
  const ids = [missionId];
  if (/bq-ch\d{2}/i.test(phaseId) || phaseId.includes("book-quality")) {
    ids.push("juno-book-quality-2026");
  }
  if (missionId === "juno-axiom-book-2026" && /bq-ch/i.test(phaseId)) {
    ids.push("juno-book-quality-2026");
  }
  return [...new Set(ids)];
}

function markProgressRow(workbench: string, missionId: string, phaseId: string): boolean {
  const progressPath = path.join(workbench, "missions", missionId, "progress.md");
  if (!existsSync(progressPath)) return false;

  let text = readFileSync(progressPath, "utf8");
  const row = new RegExp(
    `(\\|\\s*${phaseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|[^|]*\\|)\\s*(?:queued|in_progress)\\s*(\\|)`,
    "i",
  );
  if (!row.test(text)) return false;

  text = text.replace(row, "$1 done $2");
  writeFileSync(progressPath, text, "utf8");
  return true;
}

export function buildReviseImplementItem(
  reviewItem: QueueItem,
  revisionAttempt: number,
  mustFix: string[] = [],
  experimentPromptBinding?: WorkflowExperimentRevisionPromptBinding,
): QueueItem {
  assertRevisionAttempt(revisionAttempt);
  const phaseId = reviewItem.phase_id ?? "fix";
  const fixList =
    mustFix.length > 0
      ? mustFix.map((f) => `- ${f}`).join("\n")
      : "address must_fix from prior review checkpoint";
  const prompt = reviewItem.prompt.startsWith("workflow_canary_")
    ? reviewItem.prompt
    : reviewItem.prompt === "executor_book_review" || reviewItem.prompt === "executor_book_write"
      ? "executor_book_write"
      : "executor_implement";
  const experimentFields = [
    reviewItem.experiment_id,
    reviewItem.experiment_arm,
    reviewItem.experiment_episode,
    reviewItem.source_phase_id,
    reviewItem.experiment_fixture_sha256,
    reviewItem.experiment_prompt_sha256,
  ];
  const isExperiment = experimentFields.some((value) => value !== undefined);
  let experimentPromptSha256: string | undefined;
  if (isExperiment) {
    if (experimentFields.some((value) => value === undefined)) {
      throw new Error("Experiment revision parent has incomplete experiment bindings");
    }
    if (!experimentPromptBinding) {
      throw new Error("Experiment revision requires an immutable proposal prompt binding");
    }
    if (experimentPromptBinding.experimentId !== reviewItem.experiment_id) {
      throw new Error("Experiment revision proposal does not match its parent experiment");
    }
    const promptMap = experimentPromptBinding.promptSha256ByTemplate;
    if (!promptMap || typeof promptMap !== "object" || Array.isArray(promptMap)) {
      throw new Error("Experiment revision proposal prompt binding is invalid");
    }
    const parentPromptSha256 = Object.hasOwn(promptMap, reviewItem.prompt)
      ? promptMap[reviewItem.prompt]
      : undefined;
    if (!parentPromptSha256 || !SHA256.test(parentPromptSha256)) {
      throw new Error(
        `Experiment revision proposal is missing parent prompt template: ${reviewItem.prompt}`,
      );
    }
    if (reviewItem.experiment_prompt_sha256 !== parentPromptSha256) {
      throw new Error("Experiment revision parent prompt binding does not match its proposal");
    }
    experimentPromptSha256 = Object.hasOwn(promptMap, prompt)
      ? promptMap[prompt]
      : undefined;
    if (!experimentPromptSha256 || !SHA256.test(experimentPromptSha256)) {
      throw new Error(`Experiment revision proposal is missing revision prompt template: ${prompt}`);
    }
  } else if (experimentPromptBinding) {
    throw new Error("Non-experiment revision cannot use an experiment proposal prompt binding");
  }
  return {
    id: revisionFixRunId(reviewItem.id, revisionAttempt),
    horizon: reviewItem.horizon,
    kind: "implement",
    run_kind: "implement",
    repo_target: reviewItem.repo_target ?? "juno-overseer",
    prompt,
    provider: reviewItem.provider,
    max_minutes: reviewItem.max_minutes ?? 25,
    mission_id: reviewItem.mission_id,
    phase_id: phaseId,
    success_criteria: `REVISE fix attempt ${revisionAttempt}:\n${fixList}`,
    workflow_id: reviewItem.workflow_id,
    eval_profile: reviewItem.eval_profile,
    allowed_tools: reviewItem.allowed_tools,
    experiment_id: reviewItem.experiment_id,
    experiment_arm: reviewItem.experiment_arm,
    experiment_episode: reviewItem.experiment_episode,
    source_phase_id: reviewItem.source_phase_id,
    experiment_fixture_sha256: reviewItem.experiment_fixture_sha256,
    experiment_prompt_sha256: experimentPromptSha256,
    revision_of: reviewItem.id,
    revision_attempt: revisionAttempt,
  };
}

export function nextRevisionAttempt(
  workbench: string,
  parentRunId: string,
  queuedItems: QueueItem[] = [],
): number {
  revisionFixRunId(parentRunId, 1);
  const queuedAttempts = new Set<number>();
  for (const item of queuedItems) {
    if (item.revision_of !== parentRunId) continue;
    assertRevisionAttempt(item.revision_attempt);
    if (item.id !== revisionFixRunId(parentRunId, item.revision_attempt)) {
      throw new Error(`Queued revision id does not match its lineage: ${item.id}`);
    }
    queuedAttempts.add(item.revision_attempt);
  }

  for (let attempt = 1; attempt <= MAX_REVISION_ATTEMPTS; attempt += 1) {
    if (queuedAttempts.has(attempt)) continue;
    const candidate = revisionFixRunId(parentRunId, attempt);
    if (!existsSync(path.join(workbench, "runs", candidate))) return attempt;
  }
  throw new Error(`Revision attempt limit reached for ${parentRunId}`);
}

export { isReviewPass, parseReviewVerdict, resolveQueueAdvance };
