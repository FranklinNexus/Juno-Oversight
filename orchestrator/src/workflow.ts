import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeEvalProfile, type EvalProfile } from "./eval-profile.js";
import type { RunKind } from "./types.js";

export interface WorkflowSlot {
  kind: RunKind;
  prompt: string;
  missionId?: string;
  phaseId?: string;
}

export interface WorkflowDefinition {
  id: string;
  version: number;
  description: string;
  evalProfile: EvalProfile;
  slots: WorkflowSlot[];
}

export function workflowsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows");
}

export function loadWorkflow(workflowId: string): WorkflowDefinition {
  const filePath = path.join(workflowsDir(), `${workflowId}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`workflow not found: ${workflowId} (${filePath})`);
  }
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as WorkflowDefinition;
  if (!raw.id || !Array.isArray(raw.slots) || raw.slots.length === 0) {
    throw new Error(`invalid workflow: ${workflowId}`);
  }
  raw.evalProfile = normalizeEvalProfile(raw.evalProfile);
  return raw;
}

export function listWorkflowIds(): string[] {
  const dir = workflowsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}
