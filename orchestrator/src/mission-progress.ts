import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { workbenchRoot } from "./env.js";
import {
  isReviewBlocked,
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

export function checkpointTextForAdvance(
  workbench: string,
  runId: string,
  missionId?: string,
): string {
  const runText = readCheckpoint(workbench, runId);
  if (/##\s*VERIFY_REPORT|REVIEW_VERDICT|STATUS:\s*COMPLETE/i.test(runText)) {
    return runText;
  }
  if (missionId) {
    const missionCp = path.join(workbench, "missions", missionId, "checkpoint.md");
    if (existsSync(missionCp)) {
      return readFileSync(missionCp, "utf8");
    }
  }
  return runText;
}

/** Run checkpoint still at materialize stub (no gate markers). */
export function isRunCheckpointStub(checkpointText: string): boolean {
  return !/##\s*VERIFY_REPORT|REVIEW_VERDICT|STATUS:\s*COMPLETE/i.test(checkpointText);
}

/**
 * When Live Agent wrote mission-level checkpoint but left run checkpoint as stub,
 * mirror mission content into runs/<id>/checkpoint.md and ensure STATUS: COMPLETE for implement.
 */
export function finalizeRunCheckpoint(
  workbench: string,
  runId: string,
  missionId: string | undefined,
  runKind: RunKind,
): boolean {
  if (runKind !== "implement" || !missionId) return false;

  const runCpPath = path.join(workbench, "runs", runId, "checkpoint.md");
  const runText = readCheckpoint(workbench, runId);
  if (!isRunCheckpointStub(runText)) return false;

  const missionCpPath = path.join(workbench, "missions", missionId, "checkpoint.md");
  if (!existsSync(missionCpPath)) return false;
  const missionText = readFileSync(missionCpPath, "utf8");
  if (!/##\s*CHANGES/i.test(missionText)) return false;

  let body = missionText.trim();
  if (!/STATUS:\s*COMPLETE/i.test(body)) {
    body += "\n\nSTATUS: COMPLETE\n";
  }
  writeFileSync(runCpPath, `${body}\n`, "utf8");
  return true;
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

export function evaluateCompletedRun(
  workbench: string,
  runId: string,
  missionId?: string,
): QueueAdvanceAction {
  const checkpoint = checkpointTextForAdvance(workbench, runId, missionId);
  const runKind = readRunKind(workbench, runId);
  return resolveQueueAdvance(runKind, checkpoint);
}

/** Whether a completed slot should flip progress.md phase row to `done`. */
export function shouldMarkPhaseDone(runKind: RunKind, checkpointText: string): boolean {
  if (runKind === "implement") {
    return /STATUS:\s*COMPLETE/i.test(checkpointText);
  }
  if (runKind === "review" || runKind === "debate" || runKind === "vote") {
    return isReviewPass(checkpointText);
  }
  if (runKind === "verify") {
    if (isReviewBlocked(checkpointText)) return false;
    if (/##\s*VERIFY_REPORT[\s\S]*?\*\*FAIL\*\*|verdict:\s*BLOCK/i.test(checkpointText)) {
      return false;
    }
    return /##\s*VERIFY_REPORT/i.test(checkpointText);
  }
  return false;
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
  reviseIndex: number,
  mustFix: string[] = [],
): QueueItem {
  const phaseId = reviewItem.phase_id ?? "fix";
  const fixList =
    mustFix.length > 0
      ? mustFix.map((f) => `- ${f}`).join("\n")
      : "address must_fix from prior review checkpoint";
  return {
    id: `${reviewItem.mission_id ?? "mission"}-${phaseId}-revise-${reviseIndex}`,
    horizon: reviewItem.horizon,
    kind: "implement",
    run_kind: "implement",
    repo_target: reviewItem.repo_target ?? "juno-overseer",
    prompt: reviewItem.prompt === "executor_book_review" ? "executor_book_write" : "executor_implement",
    provider: reviewItem.provider,
    max_minutes: reviewItem.max_minutes ?? 25,
    mission_id: reviewItem.mission_id,
    phase_id: phaseId,
    success_criteria: `REVISE fix slot ${reviseIndex}:\n${fixList}`,
  };
}

export { isReviewPass, parseReviewVerdict, resolveQueueAdvance };
