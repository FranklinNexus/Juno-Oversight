import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { junoProjectRoot, nowIso, workbenchRoot } from "./env.js";
import { getSafetyDoctrineExcerpt } from "./safety-doctrine.js";
import { writeMcpHints } from "./mcp-config.js";
import { parseReviewVerdict } from "./review-loop.js";
import { normalizeEvalProfile, evalProfileFromWorkflow } from "./eval-profile.js";
import { loadWorkflow } from "./workflow.js";
import { readActiveWorkflowSelection } from "./workflow-search.js";
import { resolveAgentModel, resolveAgentProvider } from "./model-defaults.js";
import { ensureMissionSafetyBaseline } from "./safety-verify.js";
import {
  assertRevisionAttempt,
  assertSafeRevisionParentRunId,
  revisionFixRunId,
} from "./revision-lineage.js";
import type { QueueItem, RunManifest, RunState } from "./types.js";
import { resolveMissionDirectory, resolveRunDirectory } from "./workbench-paths.js";
import {
  readPromptTemplateSnapshot,
  resolvePromptTemplatePath,
  type PromptTemplateSnapshot,
} from "./prompt-template.js";

export { readPromptTemplateSnapshot };
export type { PromptTemplateSnapshot };

const EVENTS_TAIL_LINES = 40;
const MISSION_FILE_MAX = 6000;
const QUALITY_EXCERPT_MAX = 4000;
const MAX_RUN_MAX_RETRIES = 20;
const MAX_RUN_MINUTES = 240;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readJsonFile<T>(filePath: string): T {
  let text = readFileSync(filePath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text) as T;
}

export function writeJsonFile(filePath: string, data: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function runDirFor(workbench: string, runId: string): string {
  return resolveRunDirectory(workbench, runId);
}

export function ensureRunLayout(runDir: string): void {
  mkdirSync(path.join(runDir, "output"), { recursive: true });
  const checkpoint = path.join(runDir, "checkpoint.md");
  try {
    readFileSync(checkpoint, "utf8");
  } catch {
    writeFileSync(
      checkpoint,
      "# Checkpoint\n\n## 目标\n（待 Agent 填写）\n\n## 进度\n- [ ] slot 0\n",
      "utf8",
    );
  }
}

export function loadRunState(runDir: string): RunState {
  const p = path.join(runDir, "run-state.json");
  if (!existsSync(p)) return { retryCount: 0, slotIndex: 0, maxRetries: 3 };
  let parsed: unknown;
  try {
    parsed = readJsonFile<unknown>(p);
  } catch (error) {
    throw new Error(
      `Invalid run-state JSON: ${p}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateRunState(parsed, p);
}

export function saveRunState(runDir: string, state: RunState): void {
  validateRunState(state, path.join(runDir, "run-state.json"));
  writeJsonFile(path.join(runDir, "run-state.json"), state);
}

function validateRunState(value: unknown, target: string): RunState {
  if (!isRecord(value)) throw new Error(`Invalid run-state object: ${target}`);
  for (const key of ["retryCount", "slotIndex", "maxRetries"] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
      throw new Error(`Invalid run-state ${key}: expected a non-negative safe integer`);
    }
  }
  if ((value.maxRetries as number) > MAX_RUN_MAX_RETRIES) {
    throw new Error(`Invalid run-state maxRetries: maximum is ${MAX_RUN_MAX_RETRIES}`);
  }
  if ((value.retryCount as number) > (value.maxRetries as number)) {
    throw new Error("Invalid run-state: retryCount cannot exceed maxRetries");
  }
  if (value.lastStatus !== undefined && typeof value.lastStatus !== "string") {
    throw new Error("Invalid run-state lastStatus: expected a string");
  }
  if (value.updatedAt !== undefined && typeof value.updatedAt !== "string") {
    throw new Error("Invalid run-state updatedAt: expected a string");
  }
  return value as unknown as RunState;
}

export function manifestPathForRun(workbench: string, runId: string): string {
  return path.join(runDirFor(workbench, runId), "manifest.json");
}

export function agentCheckpointPathForRun(runDir: string): string {
  return path.join(runDir, "output", "checkpoint.md");
}

export function resolveRepoCwd(manifest: RunManifest, workbench: string): string {
  if (manifest.repoRoot === "juno-overseer") {
    return junoProjectRoot();
  }
  const lexicalRoot = path.resolve(workbench);
  const target = path.resolve(lexicalRoot, manifest.cwd || ".");
  const relative = path.relative(lexicalRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Manifest cwd escapes the Workbench: ${manifest.cwd}`);
  }

  const canonicalRoot = realpathSync.native(lexicalRoot);
  let existingAncestor = target;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(`Manifest cwd has no existing Workbench ancestor: ${manifest.cwd}`);
    }
    existingAncestor = parent;
  }
  const canonicalAncestor = realpathSync.native(existingAncestor);
  const canonicalRelative = path.relative(canonicalRoot, canonicalAncestor);
  if (
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new Error(`Manifest cwd escapes the Workbench through a link: ${manifest.cwd}`);
  }

  const canonicalTarget = path.resolve(
    canonicalAncestor,
    path.relative(existingAncestor, target),
  );
  const finalRelative = path.relative(canonicalRoot, canonicalTarget);
  if (
    finalRelative === ".." ||
    finalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(finalRelative)
  ) {
    throw new Error(`Manifest cwd escapes the Workbench: ${manifest.cwd}`);
  }
  return canonicalTarget;
}

function assertExperimentPromptBinding(
  manifest: RunManifest,
  snapshot: PromptTemplateSnapshot,
): void {
  const hasExperimentMetadata = [
    manifest.experimentId,
    manifest.experimentArm,
    manifest.experimentEpisode,
    manifest.sourcePhaseId,
    manifest.experimentFixtureSha256,
    manifest.experimentPromptSha256,
  ].some((value) => value !== undefined);
  if (hasExperimentMetadata && manifest.experimentPromptSha256 === undefined) {
    throw new Error("Workflow experiment prompt SHA-256 binding is missing");
  }
  if (
    manifest.experimentPromptSha256 !== undefined &&
    manifest.experimentPromptSha256 !== snapshot.sha256
  ) {
    throw new Error(
      `Workflow experiment prompt template changed: ${manifest.promptTemplate}; expected SHA-256 ${manifest.experimentPromptSha256}, received ${snapshot.sha256}`,
    );
  }
}

export function validateRunManifestControlFields(
  value: unknown,
  workbench: string,
): RunManifest {
  if (!isRecord(value)) throw new Error("Run manifest must be a JSON object");
  if (typeof value.runId !== "string") throw new Error("Run manifest runId must be a string");
  resolveRunDirectory(workbench, value.runId);
  if (value.missionId !== undefined) {
    if (typeof value.missionId !== "string") {
      throw new Error("Run manifest missionId must be a string when present");
    }
    resolveMissionDirectory(workbench, value.missionId);
  }
  if (!(["day", "mission"] as unknown[]).includes(value.horizon)) {
    throw new Error(`Invalid run manifest horizon: ${String(value.horizon)}`);
  }
  if (!(["implement", "review", "verify", "debate", "vote"] as unknown[]).includes(value.runKind)) {
    throw new Error(`Invalid run manifest runKind: ${String(value.runKind)}`);
  }
  if (!(["workbench", "juno-overseer"] as unknown[]).includes(value.repoRoot)) {
    throw new Error(`Invalid run manifest repoRoot: ${String(value.repoRoot)}`);
  }
  if (!(["api_token", "cursor_composer", "openai_codex"] as unknown[]).includes(value.provider)) {
    throw new Error(`Invalid run manifest provider: ${String(value.provider)}`);
  }
  if (
    !Number.isSafeInteger(value.maxMinutes) ||
    (value.maxMinutes as number) < 1 ||
    (value.maxMinutes as number) > MAX_RUN_MINUTES
  ) {
    throw new Error(`Run manifest maxMinutes must be an integer between 1 and ${MAX_RUN_MINUTES}`);
  }
  if (
    !Number.isSafeInteger(value.maxRetries) ||
    (value.maxRetries as number) < 0 ||
    (value.maxRetries as number) > MAX_RUN_MAX_RETRIES
  ) {
    throw new Error(
      `Run manifest maxRetries must be an integer between 0 and ${MAX_RUN_MAX_RETRIES}`,
    );
  }
  if (typeof value.promptTemplate !== "string") {
    throw new Error("Run manifest promptTemplate must be a string");
  }
  resolvePromptTemplatePath(workbench, value.promptTemplate);
  if (typeof value.cwd !== "string" || value.cwd.length === 0) {
    throw new Error("Run manifest cwd must be a non-empty string");
  }
  if (
    value.evalProfile !== undefined &&
    !(["code", "ui", "literature", "orchestrator"] as unknown[]).includes(value.evalProfile)
  ) {
    throw new Error(`Invalid run manifest evalProfile: ${String(value.evalProfile)}`);
  }
  if (
    value.allowedTools !== undefined &&
    (!Array.isArray(value.allowedTools) ||
      value.allowedTools.some((tool) => typeof tool !== "string" || tool.length === 0))
  ) {
    throw new Error("Run manifest allowedTools must contain non-empty strings");
  }
  for (const key of [
    "phaseId",
    "providerRef",
    "model",
    "outputDir",
    "successCriteria",
    "workflowId",
    "experimentId",
    "sourcePhaseId",
    "experimentFixtureSha256",
    "experimentPromptSha256",
    "revisionOf",
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`Run manifest ${key} must be a string when present`);
    }
  }
  if (
    value.experimentArm !== undefined &&
    value.experimentArm !== "baseline" &&
    value.experimentArm !== "candidate"
  ) {
    throw new Error(`Invalid run manifest experimentArm: ${String(value.experimentArm)}`);
  }
  if (
    value.experimentEpisode !== undefined &&
    (!Number.isSafeInteger(value.experimentEpisode) ||
      (value.experimentEpisode as number) < 1 ||
      (value.experimentEpisode as number) > 99)
  ) {
    throw new Error("Run manifest experimentEpisode must be an integer between 1 and 99");
  }
  const experimentFields = [
    value.experimentId,
    value.experimentArm,
    value.experimentEpisode,
    value.sourcePhaseId,
    value.experimentFixtureSha256,
    value.experimentPromptSha256,
  ];
  if (
    experimentFields.some((entry) => entry !== undefined) &&
    experimentFields.some((entry) => entry === undefined)
  ) {
    throw new Error("Run manifest experiment metadata must be complete");
  }
  if (
    experimentFields.every((entry) => entry !== undefined) &&
    (
      !value.missionId ||
      !value.phaseId ||
      !value.workflowId ||
      !value.evalProfile ||
      value.repoRoot !== "workbench" ||
      value.cwd !== `missions/${value.missionId}`
    )
  ) {
    throw new Error(
      "Run manifest experiment metadata requires workflow/phase bindings and an isolated mission cwd",
    );
  }
  if (
    value.experimentFixtureSha256 !== undefined &&
    (typeof value.experimentFixtureSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.experimentFixtureSha256))
  ) {
    throw new Error("Run manifest experimentFixtureSha256 must be SHA-256");
  }
  if (
    value.experimentPromptSha256 !== undefined &&
    (typeof value.experimentPromptSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.experimentPromptSha256))
  ) {
    throw new Error("Run manifest experimentPromptSha256 must be SHA-256");
  }
  if (value.revisionOf !== undefined) assertSafeRevisionParentRunId(value.revisionOf);
  if (value.revisionAttempt !== undefined) assertRevisionAttempt(value.revisionAttempt);
  if ((value.revisionOf === undefined) !== (value.revisionAttempt === undefined)) {
    throw new Error("Run manifest revisionOf and revisionAttempt must be provided together");
  }
  if (value.revisionOf !== undefined && value.revisionAttempt !== undefined) {
    if (value.runKind !== "implement") {
      throw new Error("Run manifest revision lineage requires runKind=implement");
    }
    if (value.runId !== revisionFixRunId(value.revisionOf, value.revisionAttempt)) {
      throw new Error("Run manifest runId does not match its revision lineage");
    }
  }

  const manifest = value as unknown as RunManifest;
  resolveRepoCwd(manifest, workbench);
  return manifest;
}

function inferRunKind(item: QueueItem): RunManifest["runKind"] {
  if (item.run_kind) return item.run_kind;
  if (item.kind === "review" || item.prompt.includes("review")) return "review";
  if (item.kind === "verify" || item.prompt.includes("verify")) return "verify";
  return "implement";
}

function inferRepoTarget(item: QueueItem): RunManifest["repoRoot"] {
  if (item.repo_target) return item.repo_target;
  return "workbench";
}

export function buildManifestFromQueue(
  item: QueueItem,
  workbench = workbenchRoot(),
): RunManifest {
  if (item.mission_id) resolveMissionDirectory(workbench, item.mission_id);
  const provider = resolveAgentProvider(workbench, item.provider);
  const repoRoot = inferRepoTarget(item);
  const runKind = inferRunKind(item);

  const workflowId =
    item.workflow_id ?? readActiveWorkflowSelection(workbench, item.mission_id);
  let evalProfile = item.eval_profile;
  if (workflowId) {
    try {
      const wf = loadWorkflow(workflowId);
      evalProfile = evalProfile ?? wf.evalProfile;
    } catch {
      // queue item may reference workflow not yet materialized
    }
  }
  evalProfile = normalizeEvalProfile(
    evalProfile ?? evalProfileFromWorkflow(workflowId),
  );

  let cwd: string;
  if (repoRoot === "juno-overseer") {
    cwd = ".";
  } else if (item.kind === "site") {
    cwd = item.mission_id ? `staging/sites/${item.mission_id}` : "staging/sites";
  } else if (item.horizon === "mission" && item.mission_id) {
    cwd = `missions/${item.mission_id}`;
  } else {
    cwd = `staging/${item.kind}`;
  }

  return {
    runId: item.id,
    horizon: item.horizon,
    missionId: item.mission_id,
    phaseId: item.phase_id,
    runKind,
    repoRoot,
    provider,
    providerRef: provider === "api_token" ? "openai" : "codex.local",
    model:
      provider === "api_token"
        ? "gpt-4o"
        : resolveAgentModel(provider, item.model),
    promptTemplate: item.prompt,
    cwd,
    maxMinutes: item.max_minutes ?? 25,
    maxRetries: 3,
    outputDir: "output",
    successCriteria: item.success_criteria ?? "Update checkpoint.md with progress",
    workflowId,
    evalProfile,
    allowedTools: item.allowed_tools,
    experimentId: item.experiment_id,
    experimentArm: item.experiment_arm,
    experimentEpisode: item.experiment_episode,
    sourcePhaseId: item.source_phase_id,
    experimentFixtureSha256: item.experiment_fixture_sha256,
    experimentPromptSha256: item.experiment_prompt_sha256,
    revisionOf: item.revision_of,
    revisionAttempt: item.revision_attempt,
  };
}

function readExcerpt(filePath: string, maxChars: number): string {
  if (!existsSync(filePath)) return "（文件不存在）";
  const text = readFileSync(filePath, "utf8");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…（截断）`;
}

function tailEvents(runDir: string, maxLines: number): string {
  const eventsPath = path.join(runDir, "events.jsonl");
  if (!existsSync(eventsPath)) return "（无 events）";
  const lines = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
  const tail = lines.slice(-maxLines);
  return tail.join("\n") || "（无 events）";
}

function loadMissionContext(missionId: string, workbench: string): string {
  const dir = resolveMissionDirectory(workbench, missionId);
  const scope = readExcerpt(path.join(dir, "scope-lock.md"), MISSION_FILE_MAX);
  const north = readExcerpt(path.join(dir, "north-star.md"), MISSION_FILE_MAX);
  const progress = readExcerpt(path.join(dir, "progress.md"), 3000);
  return [
    "## Mission scope-lock",
    scope,
    "",
    "## Mission north-star",
    north,
    "",
    "## Mission progress",
    progress,
  ].join("\n");
}

function loadMustFixContext(workbench: string, missionId: string, phaseId?: string): string {
  if (!phaseId) return "";
  const missionDir = resolveMissionDirectory(workbench, missionId);
  if (!existsSync(missionDir)) return "";

  const runsDir = path.join(workbench, "runs");
  if (!existsSync(runsDir)) return "";

  let latestReview = "";
  const reviewKey = phaseId.replace(/-write$/, "-review").replace(/-revise-\d+$/, "-review");
  for (const runId of readdirSync(runsDir)) {
    if (!runId.includes(reviewKey)) continue;
    const cpPath = path.join(runsDir, runId, "checkpoint.md");
    if (!existsSync(cpPath)) continue;
    const cp = readFileSync(cpPath, "utf8");
    const parsed = parseReviewVerdict(cp);
    if (parsed?.verdict === "REVISE" && parsed.mustFixNextSlot.length > 0) {
      latestReview = parsed.mustFixNextSlot.map((f) => `- ${f}`).join("\n");
    }
  }
  if (!latestReview) return "";
  return ["## must_fix from prior review", latestReview, ""].join("\n");
}

function loadMcpContext(manifest: RunManifest, workbench: string): string {
  const hints = writeMcpHints(workbench, {
    missionId: manifest.missionId,
    repoRoot: manifest.repoRoot,
    provider: manifest.provider,
  });
  return hints.promptBlock;
}

export function canonicalizeRunManifest(
  manifest: RunManifest,
  workbench: string,
): RunManifest {
  if (!(["api_token", "cursor_composer", "openai_codex"] as unknown[]).includes(manifest.provider)) {
    throw new Error(`Invalid run manifest provider: ${String(manifest.provider)}`);
  }
  const provider = resolveAgentProvider(workbench, manifest.provider);
  return {
    ...manifest,
    runKind: manifest.runKind === undefined ? "implement" : manifest.runKind,
    repoRoot: manifest.repoRoot === undefined ? "workbench" : manifest.repoRoot,
    provider,
    providerRef: provider === "api_token" ? "openai" : "codex.local",
    model:
      provider === "api_token"
        ? manifest.model ?? "gpt-4o"
        : resolveAgentModel(provider, manifest.model),
  };
}

function loadQualityExcerpt(): string {
  const qualityPath = path.join(junoProjectRoot(), "wiki", "overseer-quality.md");
  return readExcerpt(qualityPath, QUALITY_EXCERPT_MAX);
}

function runKindGuard(runKind: RunManifest["runKind"]): string {
  if (runKind === "review") {
    return "本 slot 为 **Review**：禁止新功能与大重构；只写 REVIEW_VERDICT 与 checkpoint。";
  }
  if (runKind === "verify") {
    return "本 slot 为 **Verify**：只跑测试并写 VERIFY_REPORT；不修代码。";
  }
  return "本 slot 为 **Implement**：可改代码，但必须在 scope-lock 允许路径内。";
}

export function materializeQueueRun(item: QueueItem): string {
  const workbench = workbenchRoot();
  const runDir = runDirFor(workbench, item.id);
  const manifest = validateRunManifestControlFields(buildManifestFromQueue(item), workbench);
  if (manifest.experimentPromptSha256 !== undefined) {
    assertExperimentPromptBinding(
      manifest,
      readPromptTemplateSnapshot(workbench, manifest.promptTemplate),
    );
  }
  mkdirSync(runDir, { recursive: true });
  ensureRunLayout(runDir);
  if (manifest.runKind === "implement" && manifest.missionId) {
    ensureMissionSafetyBaseline(workbench, manifest.missionId);
  }
  const manifestPath = path.join(runDir, "manifest.json");
  writeJsonFile(manifestPath, manifest);
  const state = loadRunState(runDir);
  state.maxRetries = manifest.maxRetries;
  saveRunState(runDir, state);
  writeFileSync(
    path.join(runDir, "queue-item.json"),
    JSON.stringify({ ...item, materializedAt: nowIso() }, null, 2),
    "utf8",
  );
  return manifestPath;
}

export function buildUserPrompt(
  manifest: RunManifest,
  workbench: string,
  runDir: string,
  runState: RunState,
): string {
  const promptTemplate = readPromptTemplateSnapshot(workbench, manifest.promptTemplate);
  assertExperimentPromptBinding(manifest, promptTemplate);
  const template = promptTemplate.text;
  let checkpoint = "";
  try {
    checkpoint = readFileSync(path.join(runDir, "checkpoint.md"), "utf8");
  } catch {
    checkpoint = "（无 checkpoint）";
  }

  const repoCwd = resolveRepoCwd(manifest, workbench);
  const missionCtx = manifest.missionId
    ? loadMissionContext(manifest.missionId, workbench)
    : "";
  const qualityExcerpt = loadQualityExcerpt();
  const mustFixCtx = manifest.missionId
    ? loadMustFixContext(workbench, manifest.missionId, manifest.phaseId)
    : "";
  const mcpCtx = loadMcpContext(manifest, workbench);
  const eventsTail = tailEvents(runDir, EVENTS_TAIL_LINES);
  const kindGuard = runKindGuard(manifest.runKind);

  const retryNote =
    runState.retryCount > 0
      ? `\n## 续跑指令\n这是第 ${runState.slotIndex + 1} 个 slot（retry ${runState.retryCount}）。只读 checkpoint，继续完成 successCriteria，不要重复已完成工作。\n`
      : "";

  const vaultNote =
    manifest.repoRoot === "juno-overseer"
      ? "工作目录为 Juno Oversight 仓库。禁止读写 Obsidian Vault。"
      : "工作目录为 Agent Workbench。禁止 Obsidian Vault。";
  const missionCheckpointNote = manifest.missionId
    ? `${path.join(resolveMissionDirectory(workbench, manifest.missionId), "checkpoint.md")} 是只读展示文件；不得创建、修改或删除。Mission 完成只能由父进程签发 receipt。`
    : "";

  return [
    "# Juno Overseer Run",
    "",
    `- runId: ${manifest.runId}`,
    `- slot: ${runState.slotIndex}`,
    `- runKind: ${manifest.runKind ?? "implement"}`,
    `- repoRoot: ${manifest.repoRoot ?? "workbench"}`,
    `- horizon: ${manifest.horizon}`,
    manifest.missionId ? `- missionId: ${manifest.missionId}` : "",
    manifest.phaseId ? `- phaseId: ${manifest.phaseId}` : "",
    `- provider: ${manifest.provider}`,
    `- maxMinutes: ${manifest.maxMinutes}`,
    `- successCriteria: ${manifest.successCriteria ?? "见 manifest"}`,
    `- repo cwd: ${repoCwd}`,
    `- checkpoint path: ${agentCheckpointPathForRun(runDir)}`,
    "",
    kindGuard,
    retryNote,
    getSafetyDoctrineExcerpt(),
    "## Quality doctrine (excerpt)",
    qualityExcerpt,
    mustFixCtx,
    "## MCP (workbench registry)",
    mcpCtx,
    missionCtx,
    "",
    "## Prompt template",
    template,
    "",
    "## Checkpoint",
    checkpoint,
    "",
    "## Recent events (tail)",
    eventsTail,
    "",
    missionCheckpointNote,
    `${vaultNote} 本 slot 结束前更新上面的 agent checkpoint path（implement 须含 STATUS: COMPLETE + ## CHANGES）。manifest.json、run-state.json、events.jsonl 与 runs/${manifest.runId}/checkpoint.md 是只读控制文件，不得修改。`,
  ]
    .filter(Boolean)
    .join("\n");
}
