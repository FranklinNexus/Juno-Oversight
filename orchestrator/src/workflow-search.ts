import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { observeRunOutcome } from "./run-outcome.js";
import { loadWorkflow, workflowsDir } from "./workflow.js";
import { readTrustedWorkflowSelection } from "./workflow-experiment.js";
import type { RunKind } from "./types.js";

export interface WorkflowScore {
  workflowId: string;
  score: number;
  reasons: string[];
}

export interface WorkflowSearchSignals {
  testsPass?: boolean;
  verifyPass?: boolean;
  safetyPass?: boolean;
  slotCount?: number;
  sampleSize?: number;
  successCount?: number;
  failureCount?: number;
  verifyPassCount?: number;
  verifyFailCount?: number;
  reviseCount?: number;
  safetyBlockCount?: number;
}

const VARIANTS_DIR = "variants";

export function readActiveWorkflowSelection(
  workbench: string,
  missionId?: string,
): string | undefined {
  if (!missionId) return undefined;
  return readTrustedWorkflowSelection(workbench, missionId);
}

/** List workflow ids in orchestrator/workflows/ and workflows/variants/. */
export function listSearchableWorkflows(): string[] {
  const root = workflowsDir();
  const ids = new Set<string>();
  if (existsSync(root)) {
    for (const f of readdirSync(root)) {
      if (f.endsWith(".json") && f !== "README.md") ids.add(f.replace(/\.json$/, ""));
    }
  }
  const varDir = path.join(root, VARIANTS_DIR);
  if (existsSync(varDir)) {
    for (const f of readdirSync(varDir)) {
      if (f.endsWith(".json")) ids.add(`${VARIANTS_DIR}/${f.replace(/\.json$/, "")}`);
    }
  }
  return [...ids].sort();
}

function loadSearchableWorkflow(workflowId: string) {
  return loadWorkflow(workflowId);
}

/** OPRO-lite: score workflow variants from verify signals (higher = better). */
export function scoreWorkflow(
  workflowId: string,
  signals: WorkflowSearchSignals = {},
): WorkflowScore {
  const reasons: string[] = [];
  let score = 0;

  try {
    const wf = loadSearchableWorkflow(workflowId);
    score += 10;
    reasons.push("valid workflow JSON");
    const slots = wf.slots?.length ?? 0;
    score -= Math.max(0, slots - 1);
    reasons.push(`slot_cost=${Math.max(0, slots - 1)}`);
    if (wf.evalProfile === "orchestrator") {
      score += 1;
      reasons.push("orchestrator evalProfile");
    }
  } catch {
    return { workflowId, score: -100, reasons: ["invalid or missing workflow"] };
  }

  if (signals.testsPass) {
    score += 20;
    reasons.push("testsPass");
  }
  if (signals.verifyPass) {
    score += 25;
    reasons.push("verifyPass");
  }
  if (signals.safetyPass) {
    score += 15;
    reasons.push("safetyPass");
  }
  if (signals.slotCount != null) {
    score -= Math.max(0, signals.slotCount - 1);
  }

  const sampleSize = signals.sampleSize ?? 0;
  if (sampleSize > 0) {
    const successRate = (signals.successCount ?? 0) / sampleSize;
    const failureRate = (signals.failureCount ?? 0) / sampleSize;
    score += 30 * successRate;
    score -= 35 * failureRate;
    score -= 10 * ((signals.reviseCount ?? 0) / sampleSize);
    reasons.push(`evidence=${sampleSize}`);
    reasons.push(`success_rate=${successRate.toFixed(2)}`);
    reasons.push(`failure_rate=${failureRate.toFixed(2)}`);
  } else {
    reasons.push("no runtime evidence");
  }

  const verifyTotal = (signals.verifyPassCount ?? 0) + (signals.verifyFailCount ?? 0);
  if (verifyTotal > 0) {
    const verifyRate = (signals.verifyPassCount ?? 0) / verifyTotal;
    score += 25 * verifyRate;
    score -= 25 * (1 - verifyRate);
    reasons.push(`verify_rate=${verifyRate.toFixed(2)}`);
  }
  if ((signals.safetyBlockCount ?? 0) > 0) {
    score -= 50;
    reasons.push(`safety_blocks=${signals.safetyBlockCount}`);
  }

  return { workflowId, score, reasons };
}

/** Read evidence produced by runs of one workflow. Unknown evidence remains unknown, never PASS. */
export function workflowSignalsFromRuns(
  workbench: string,
  workflowId: string,
): WorkflowSearchSignals {
  const signals: Required<
    Pick<
      WorkflowSearchSignals,
      | "sampleSize"
      | "successCount"
      | "failureCount"
      | "verifyPassCount"
      | "verifyFailCount"
      | "reviseCount"
      | "safetyBlockCount"
    >
  > = {
    sampleSize: 0,
    successCount: 0,
    failureCount: 0,
    verifyPassCount: 0,
    verifyFailCount: 0,
    reviseCount: 0,
    safetyBlockCount: 0,
  };
  const runsDir = path.join(workbench, "runs");
  if (!existsSync(runsDir)) return signals;

  for (const name of readdirSync(runsDir)) {
    const runDir = path.join(runsDir, name);
    let manifest: { workflowId?: string; runKind?: RunKind };
    try {
      manifest = JSON.parse(readFileSync(path.join(runDir, "manifest.json"), "utf8")) as typeof manifest;
    } catch {
      continue;
    }
    if (manifest.workflowId !== workflowId) continue;
    let lastStatus = "";
    try {
      const state = JSON.parse(readFileSync(path.join(runDir, "run-state.json"), "utf8")) as {
        lastStatus?: string;
      };
      lastStatus = state.lastStatus ?? "";
    } catch {
      /* no terminal state */
    }

    const checkpointPath = path.join(runDir, "checkpoint.md");
    const checkpoint = existsSync(checkpointPath) ? readFileSync(checkpointPath, "utf8") : "";
    const safetyPath = path.join(runDir, "safety-verify.md");
    const safety = existsSync(safetyPath) ? readFileSync(safetyPath, "utf8") : "";
    const outcome = observeRunOutcome(
      manifest.runKind ?? "implement",
      lastStatus,
      checkpoint,
      safety,
    );
    if (!outcome.observed) continue;
    signals.sampleSize += 1;
    if (outcome.success) signals.successCount += 1;
    if (outcome.failure) signals.failureCount += 1;
    if (outcome.revised) signals.reviseCount += 1;
    if (outcome.verifyPass) signals.verifyPassCount += 1;
    if (outcome.verifyFail) signals.verifyFailCount += 1;
    if (outcome.safetyBlocked) signals.safetyBlockCount += 1;
  }
  return signals;
}

export function selectBestWorkflow(
  workflowIds: string[],
  signals: WorkflowSearchSignals = {},
): WorkflowScore {
  const scored = workflowIds.map((id) => scoreWorkflow(id, signals));
  scored.sort((a, b) => b.score - a.score);
  return scored[0] ?? { workflowId: "default", score: 0, reasons: ["fallback"] };
}
