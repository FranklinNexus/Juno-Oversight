import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalProfile } from "./eval-profile.js";
import type { AgentProvider, QueueItem, RepoTarget, RunKind } from "./types.js";

const WORKFLOW_SELECTOR = /^(?:variants\/)?[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const RUN_KINDS = new Set<RunKind>(["implement", "review", "verify", "debate", "vote"]);
const EVAL_PROFILES = new Set<EvalProfile>(["code", "ui", "literature", "orchestrator"]);
const WORKFLOW_KEYS = new Set(["id", "version", "description", "evalProfile", "slots", "baseWorkflow"]);
const SLOT_KEYS = new Set(["kind", "prompt", "missionId", "phaseId", "dependsOn"]);

export type WorkflowExperimentArm = "baseline" | "candidate";

export interface WorkflowSlot {
  kind: RunKind;
  prompt: string;
  missionId?: string;
  phaseId?: string;
  dependsOn?: string;
}

export interface WorkflowDefinition {
  id: string;
  version: number;
  description: string;
  evalProfile: EvalProfile;
  baseWorkflow?: string;
  slots: WorkflowSlot[];
}

export interface WorkflowCompileInput {
  experimentId: string;
  arm: WorkflowExperimentArm;
  episode: number;
  missionId: string;
  sourcePhaseId: string;
  fixtureSha256: string;
  promptSha256ByTemplate: Readonly<Record<string, string>>;
  workflowId: string;
  repoTarget?: RepoTarget;
  provider?: AgentProvider;
  maxMinutes?: number;
  allowedTools?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireSafeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be a safe non-empty id`);
  }
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}

export function parseWorkflowDefinition(value: unknown, selector = "<workflow>"): WorkflowDefinition {
  if (!isRecord(value)) throw new Error(`Workflow ${selector} must be a JSON object`);
  rejectUnknownKeys(value, WORKFLOW_KEYS, `Workflow ${selector}`);
  const id = requireSafeId(value.id, `Workflow ${selector}.id`);
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    throw new Error(`Workflow ${selector}.version must be a positive safe integer`);
  }
  if (typeof value.description !== "string" || !value.description.trim()) {
    throw new Error(`Workflow ${selector}.description must be a non-empty string`);
  }
  if (typeof value.evalProfile !== "string" || !EVAL_PROFILES.has(value.evalProfile as EvalProfile)) {
    throw new Error(`Workflow ${selector}.evalProfile is invalid`);
  }
  if (value.baseWorkflow !== undefined) {
    assertWorkflowSelector(value.baseWorkflow, `Workflow ${selector}.baseWorkflow`);
  }
  if (!Array.isArray(value.slots) || value.slots.length === 0 || value.slots.length > 32) {
    throw new Error(`Workflow ${selector}.slots must contain 1-32 slots`);
  }

  const phaseIds = new Set<string>();
  const slots = value.slots.map((slotValue, index): WorkflowSlot => {
    const label = `Workflow ${selector}.slots[${index}]`;
    if (!isRecord(slotValue)) throw new Error(`${label} must be a JSON object`);
    rejectUnknownKeys(slotValue, SLOT_KEYS, label);
    if (typeof slotValue.kind !== "string" || !RUN_KINDS.has(slotValue.kind as RunKind)) {
      throw new Error(`${label}.kind is invalid`);
    }
    const prompt = requireSafeId(slotValue.prompt, `${label}.prompt`);
    const missionId = slotValue.missionId === undefined
      ? undefined
      : requireSafeId(slotValue.missionId, `${label}.missionId`);
    const phaseId = slotValue.phaseId === undefined
      ? undefined
      : requireSafeId(slotValue.phaseId, `${label}.phaseId`);
    if (phaseId && phaseIds.has(phaseId)) throw new Error(`${label}.phaseId is duplicated: ${phaseId}`);
    const dependsOn = slotValue.dependsOn === undefined
      ? undefined
      : requireSafeId(slotValue.dependsOn, `${label}.dependsOn`);
    if (dependsOn && !phaseIds.has(dependsOn)) {
      throw new Error(`${label}.dependsOn must reference an earlier slot phaseId: ${dependsOn}`);
    }
    if (phaseId) phaseIds.add(phaseId);
    return {
      kind: slotValue.kind as RunKind,
      prompt,
      missionId,
      phaseId,
      dependsOn,
    };
  });

  return {
    id,
    version: value.version as number,
    description: value.description.trim(),
    evalProfile: value.evalProfile as EvalProfile,
    baseWorkflow: value.baseWorkflow as string | undefined,
    slots,
  };
}

function assertWorkflowSelector(value: unknown, label = "workflow selector"): asserts value is string {
  if (typeof value !== "string" || !WORKFLOW_SELECTOR.test(value)) {
    throw new Error(`${label} is invalid: ${String(value)}`);
  }
}

export function workflowsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows");
}

export function workflowPath(workflowId: string): string {
  assertWorkflowSelector(workflowId);
  const root = workflowsDir();
  const target = path.resolve(root, `${workflowId}.json`);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`workflow escapes workflow library: ${workflowId}`);
  }
  return target;
}

export function loadWorkflow(workflowId: string): WorkflowDefinition {
  const filePath = workflowPath(workflowId);
  if (!existsSync(filePath)) throw new Error(`workflow not found: ${workflowId} (${filePath})`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`workflow is unreadable: ${workflowId}`, { cause: error });
  }
  return parseWorkflowDefinition(raw, workflowId);
}

export function workflowDefinitionSha256(workflow: WorkflowDefinition): string {
  return createHash("sha256").update(JSON.stringify(workflow), "utf8").digest("hex");
}

export function listWorkflowIds(): string[] {
  const root = workflowsDir();
  if (!existsSync(root)) return [];
  const ids = readdirSync(root)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""));
  const variants = path.join(root, "variants");
  if (existsSync(variants)) {
    ids.push(
      ...readdirSync(variants)
        .filter((file) => file.endsWith(".json"))
        .map((file) => `variants/${file.replace(/\.json$/, "")}`),
    );
  }
  return ids.sort();
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function compiledPhaseId(input: WorkflowCompileInput, slot: WorkflowSlot, index: number): string {
  const slotLabel = slot.phaseId ?? `${slot.kind}-${index + 1}`;
  const phaseId = `${input.sourcePhaseId}-${input.arm}-${input.episode}-${slotLabel}`;
  if (phaseId.length <= 127) return phaseId;
  return `${phaseId.slice(0, 110)}-${shortHash(phaseId)}`;
}

/** Compile a workflow into real, isolated queue runs for one experiment episode. */
export function compileWorkflowSlots(input: WorkflowCompileInput): QueueItem[] {
  requireSafeId(input.experimentId, "experimentId");
  requireSafeId(input.missionId, "missionId");
  requireSafeId(input.sourcePhaseId, "sourcePhaseId");
  assertWorkflowSelector(input.workflowId, "workflowId");
  if (!/^[a-f0-9]{64}$/.test(input.fixtureSha256)) {
    throw new Error("fixtureSha256 must be SHA-256");
  }
  if (input.arm !== "baseline" && input.arm !== "candidate") throw new Error("arm is invalid");
  if (!Number.isSafeInteger(input.episode) || input.episode < 1 || input.episode > 99) {
    throw new Error("episode must be an integer between 1 and 99");
  }
  if (input.maxMinutes !== undefined && (!Number.isSafeInteger(input.maxMinutes) || input.maxMinutes < 1 || input.maxMinutes > 240)) {
    throw new Error("maxMinutes must be an integer between 1 and 240");
  }
  const workflow = loadWorkflow(input.workflowId);
  if (!isRecord(input.promptSha256ByTemplate)) {
    throw new Error("promptSha256ByTemplate must be a template-to-SHA-256 mapping");
  }
  const promptHashEntries = Object.entries(input.promptSha256ByTemplate);
  if (promptHashEntries.length < 1 || promptHashEntries.length > 32) {
    throw new Error("promptSha256ByTemplate must contain 1-32 templates");
  }
  const promptSha256ByTemplate: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [template, sha256] of promptHashEntries) {
    requireSafeId(template, "promptSha256ByTemplate template");
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`promptSha256ByTemplate.${template} must be SHA-256`);
    }
    promptSha256ByTemplate[template] = sha256;
  }
  for (const template of new Set(workflow.slots.map((slot) => slot.prompt))) {
    if (!Object.hasOwn(promptSha256ByTemplate, template)) {
      throw new Error(`promptSha256ByTemplate is missing workflow template: ${template}`);
    }
  }
  const phaseMap = new Map<string, string>();
  const phases = workflow.slots.map((slot, index) => {
    const phaseId = compiledPhaseId(input, slot, index);
    if (slot.phaseId) phaseMap.set(slot.phaseId, phaseId);
    return phaseId;
  });
  const experimentKey = shortHash(input.experimentId);
  const armKey = input.arm === "baseline" ? "b" : "c";

  return workflow.slots.map((slot, index): QueueItem => {
    const dependency = slot.dependsOn
      ? phaseMap.get(slot.dependsOn)
      : index > 0
        ? phases[index - 1]
        : undefined;
    if (slot.dependsOn && !dependency) throw new Error(`Unresolved workflow dependency: ${slot.dependsOn}`);
    const item: QueueItem = {
      id: `wfexp-${experimentKey}-${armKey}${input.episode}-${String(index + 1).padStart(2, "0")}-${slot.kind}`,
      horizon: "mission",
      kind: slot.kind,
      run_kind: slot.kind,
      repo_target: input.repoTarget ?? "workbench",
      mission_id: input.missionId,
      phase_id: phases[index],
      prompt: slot.prompt,
      provider: input.provider ?? "openai_codex",
      max_minutes: input.maxMinutes ?? 25,
      success_criteria: `Workflow experiment ${input.experimentId} ${input.arm} episode ${input.episode}; source phase ${input.sourcePhaseId}`,
      workflow_id: input.workflowId,
      eval_profile: workflow.evalProfile,
      experiment_id: input.experimentId,
      experiment_arm: input.arm,
      experiment_episode: input.episode,
      source_phase_id: input.sourcePhaseId,
      experiment_fixture_sha256: input.fixtureSha256,
      experiment_prompt_sha256: promptSha256ByTemplate[slot.prompt],
    };
    if (dependency) item.depends_on = dependency;
    if (input.allowedTools?.length) item.allowed_tools = [...input.allowedTools];
    return item;
  });
}
