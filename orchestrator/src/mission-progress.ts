import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { workbenchRoot } from "./env.js";
import {
  isReviewPass,
  parseReviewVerdict,
  resolveQueueAdvance,
  type QueueAdvanceAction,
} from "./review-loop.js";
import type { QueueItem, RunKind } from "./types.js";

export function readCheckpoint(workbench: string, runId: string): string {
  const cp = path.join(workbench, "runs", runId, "checkpoint.md");
  try {
    return readFileSync(cp, "utf8");
  } catch {
    return "";
  }
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
    if (item.kind === "verify") return "verify";
  } catch {
    // fall through
  }

  return "implement";
}

export function evaluateCompletedRun(
  workbench: string,
  runId: string,
): QueueAdvanceAction {
  const checkpoint = readCheckpoint(workbench, runId);
  const runKind = readRunKind(workbench, runId);
  return resolveQueueAdvance(runKind, checkpoint);
}

export function markMissionPhaseDone(
  workbench: string,
  missionId: string,
  phaseId: string,
): boolean {
  const progressPath = path.join(workbench, "missions", missionId, "progress.md");
  if (!existsSync(progressPath)) return false;

  let text = readFileSync(progressPath, "utf8");
  const row = new RegExp(
    `(\\|\\s*${phaseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|[^|]*\\|)\\s*queued\\s*(\\|)`,
    "i",
  );
  if (!row.test(text)) return false;

  text = text.replace(row, "$1 done $2");
  writeFileSync(progressPath, text, "utf8");
  return true;
}

export function buildReviseImplementItem(
  reviewItem: QueueItem,
  reviseIndex: number,
): QueueItem {
  const phaseId = reviewItem.phase_id ?? "fix";
  return {
    id: `${reviewItem.mission_id ?? "mission"}-${phaseId}-revise-${reviseIndex}`,
    horizon: reviewItem.horizon,
    kind: "implement",
    run_kind: "implement",
    repo_target: reviewItem.repo_target ?? "juno-overseer",
    prompt: "executor_implement",
    provider: reviewItem.provider,
    max_minutes: reviewItem.max_minutes ?? 25,
    mission_id: reviewItem.mission_id,
    phase_id: phaseId,
    success_criteria: `REVISE fix slot ${reviseIndex}: address must_fix from review`,
  };
}

export { isReviewPass, parseReviewVerdict, resolveQueueAdvance };
