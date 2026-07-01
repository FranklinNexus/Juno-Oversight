import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadWorkflow, workflowsDir } from "./workflow.js";

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
}

const VARIANTS_DIR = "variants";

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
  if (workflowId.includes("/")) {
    const filePath = path.join(workflowsDir(), `${workflowId}.json`);
    if (!existsSync(filePath)) throw new Error(`variant not found: ${workflowId}`);
    return JSON.parse(readFileSync(filePath, "utf8")) as {
      id: string;
      slots: unknown[];
      evalProfile?: string;
    };
  }
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
    score += Math.min(slots, 5);
    reasons.push(`slots=${slots}`);
    if (wf.evalProfile === "orchestrator") {
      score += 3;
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
    score += Math.min(signals.slotCount, 4);
  }

  return { workflowId, score, reasons };
}

export function selectBestWorkflow(
  workflowIds: string[],
  signals: WorkflowSearchSignals = {},
): WorkflowScore {
  const scored = workflowIds.map((id) => scoreWorkflow(id, signals));
  scored.sort((a, b) => b.score - a.score);
  return scored[0] ?? { workflowId: "default", score: 0, reasons: ["fallback"] };
}
