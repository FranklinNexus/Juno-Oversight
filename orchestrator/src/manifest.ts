import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { junoProjectRoot, nowIso, workbenchRoot } from "./env.js";
import { getSafetyDoctrineExcerpt } from "./safety-doctrine.js";
import { buildMetacognitionPromptBlock } from "./metacognition.js";
import { readMcpHints, writeMcpHints } from "./mcp-config.js";
import { parseReviewVerdict } from "./review-loop.js";
import { normalizeEvalProfile, evalProfileFromWorkflow } from "./eval-profile.js";
import { loadWorkflow } from "./workflow.js";
import { resolveComposerModel } from "./model-defaults.js";
import type { QueueItem, RunManifest, RunState } from "./types.js";

const EVENTS_TAIL_LINES = 40;
const MISSION_FILE_MAX = 6000;
const QUALITY_EXCERPT_MAX = 4000;

export function readJsonFile<T>(filePath: string): T {
  let text = readFileSync(filePath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text) as T;
}

export function writeJsonFile(filePath: string, data: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function runDirFor(workbench: string, runId: string): string {
  return path.join(workbench, "runs", runId);
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
  try {
    return readJsonFile<RunState>(p);
  } catch {
    return { retryCount: 0, slotIndex: 0, maxRetries: 3 };
  }
}

export function saveRunState(runDir: string, state: RunState): void {
  writeJsonFile(path.join(runDir, "run-state.json"), state);
}

export function manifestPathForRun(workbench: string, runId: string): string {
  return path.join(runDirFor(workbench, runId), "manifest.json");
}

export function resolveRepoCwd(manifest: RunManifest, workbench: string): string {
  if (manifest.repoRoot === "juno-overseer") {
    return junoProjectRoot();
  }
  if (manifest.cwd === "." || manifest.cwd === "./") {
    return workbench;
  }
  return path.resolve(workbench, manifest.cwd);
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

export function buildManifestFromQueue(item: QueueItem): RunManifest {
  const provider = item.provider ?? "cursor_composer";
  const repoRoot = inferRepoTarget(item);
  const runKind = inferRunKind(item);

  const workflowId = item.workflow_id;
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
  } else if (item.horizon === "mission" && item.mission_id) {
    cwd = `staging/sites/${item.mission_id}`;
  } else if (item.kind === "site") {
    cwd = "staging/sites";
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
    providerRef: provider === "api_token" ? "openai" : "cursor_accounts.main",
    model:
      provider === "api_token"
        ? "gpt-4o"
        : resolveComposerModel(workbenchRoot(), item.model),
    promptTemplate: item.prompt,
    cwd,
    maxMinutes: item.max_minutes ?? 25,
    maxRetries: 3,
    outputDir: "output",
    successCriteria: item.success_criteria ?? "Update checkpoint.md with progress",
    workflowId,
    evalProfile,
    allowedTools: item.allowed_tools,
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
  const dir = path.join(workbench, "missions", missionId);
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
  const missionDir = path.join(workbench, "missions", missionId);
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
  const hints =
    readMcpHints(workbench) ??
    writeMcpHints(workbench, {
      missionId: manifest.missionId,
      repoRoot: manifest.repoRoot,
      provider: manifest.provider,
    });
  return hints.promptBlock;
}

function loadQualityExcerpt(): string {
  const qualityPath = path.join(junoProjectRoot(), "wiki", "overseer-quality.md");
  return readExcerpt(qualityPath, QUALITY_EXCERPT_MAX);
}

function runKindGuard(runKind: RunManifest["runKind"]): string {
  if (runKind === "review") {
    return "本 slot 为 **Review**：禁止新功能与大重构；必须写 **METACOGNITION** + **REVIEW_VERDICT**（无 METACOGNITION 不得 PASS）。";
  }
  if (runKind === "verify") {
    return "本 slot 为 **Verify**：只跑测试并写 VERIFY_REPORT + METACOGNITION；不修代码。";
  }
  return "本 slot 为 **Implement**：可改代码，但必须在 scope-lock 允许路径内；结束前自问 METACOGNITION。";
}

export function materializeQueueRun(item: QueueItem): string {
  const workbench = workbenchRoot();
  const runDir = runDirFor(workbench, item.id);
  mkdirSync(runDir, { recursive: true });
  ensureRunLayout(runDir);
  const manifest = buildManifestFromQueue(item);
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
  const template = readFileSync(
    path.join(workbench, "prompts", `${manifest.promptTemplate}.md`),
    "utf8",
  );
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
  const metacogBlock = buildMetacognitionPromptBlock(manifest.runKind ?? "implement", workbench);

  const retryNote =
    runState.retryCount > 0
      ? `\n## 续跑指令\n这是第 ${runState.slotIndex + 1} 个 slot（retry ${runState.retryCount}）。只读 checkpoint，继续完成 successCriteria，不要重复已完成工作。\n`
      : "";

  const vaultNote =
    manifest.repoRoot === "juno-overseer"
      ? "工作目录为 Juno Oversight 仓库。禁止读写 Obsidian Vault。"
      : "工作目录为 Agent Workbench。禁止 Obsidian Vault。";

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
    "",
    kindGuard,
    retryNote,
    metacogBlock,
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
    `${vaultNote} 本 slot 结束前更新 runs/${manifest.runId}/checkpoint.md（implement 须含 STATUS: COMPLETE + ## CHANGES）。`,
  ]
    .filter(Boolean)
    .join("\n");
}
