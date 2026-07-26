/**
 * Juno self-optimize tick: quality scan → rubric patch → workflow selection → MCP hints.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeMcpHints } from "./mcp-config.js";
import {
  BOOK_MISSION_ID,
  mustFixFromQualityReport,
  scanBookQuality,
  type BookQualityScan,
} from "./quality-gate.js";
import {
  listSearchableWorkflows,
  readActiveWorkflowSelection,
  scoreWorkflow,
  workflowSignalsFromRuns,
} from "./workflow-search.js";
import { recordEvolutionTick, isMutationPathAllowed } from "./evolution-unit.js";
import { proposeWorkflowExperiment } from "./workflow-experiment.js";
import { loadWorkflow } from "./workflow.js";

export interface SelfOptimizeConfig {
  enabled?: boolean;
  autoQueueBookRevise?: boolean;
  strictChapterLength?: boolean;
  preferredBookWorkflow?: string;
}

export interface SelfOptimizeReport {
  ranAt: string;
  autoQueueBookRevise: boolean;
  qualityScan?: BookQualityScan;
  workflowSelection?: {
    workflowId: string;
    baselineWorkflowId: string;
    score: number;
    reasons: string[];
    evidenceRuns: number;
    active: boolean;
    experimentId?: string;
    experimentStatus?: "proposed";
  };
  rubricPatched: boolean;
  mcpHintsWritten: boolean;
  recommendedActions: string[];
}

function configPath(workbench: string): string {
  return path.join(workbench, "config", "self-optimize.json");
}

function reportPath(workbench: string): string {
  return path.join(workbench, "state", "self-optimize.json");
}

function qualityScanPath(workbench: string): string {
  return path.join(workbench, "state", "quality-scan.json");
}

export function loadSelfOptimizeConfig(workbench: string): SelfOptimizeConfig {
  const p = configPath(workbench);
  if (!existsSync(p)) {
    return { enabled: true, autoQueueBookRevise: true, strictChapterLength: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (error) {
    throw new Error(`Self-optimize config is unreadable; refusing mutation: ${p}`, {
      cause: error,
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Self-optimize config must be a JSON object: ${p}`);
  }
  const config = raw as SelfOptimizeConfig;
  if (
    (config.enabled !== undefined && typeof config.enabled !== "boolean") ||
    (config.autoQueueBookRevise !== undefined &&
      typeof config.autoQueueBookRevise !== "boolean") ||
    (config.strictChapterLength !== undefined &&
      typeof config.strictChapterLength !== "boolean") ||
    (config.preferredBookWorkflow !== undefined &&
      (typeof config.preferredBookWorkflow !== "string" ||
        !config.preferredBookWorkflow.trim()))
  ) {
    throw new Error(`Self-optimize config contains invalid control fields: ${p}`);
  }
  return config;
}

export const BOOK_QUALITY_MISSION_ID = "juno-book-quality-2026";

function bookQualityMaintenancePassed(workbench: string): boolean {
  const cp = path.join(workbench, "missions", BOOK_QUALITY_MISSION_ID, "checkpoint.md");
  if (!existsSync(cp)) return false;
  return /^STATUS:\s*MAINTENANCE_PASS\s*$/m.test(readFileSync(cp, "utf8"));
}

/** Record maintenance health without pretending that a terminal verify receipt exists. */
export function syncBookQualityMissionComplete(workbench: string): boolean {
  const scan = readQualityScan(workbench);
  if (!scan || scan.failedChapters.length > 0) return false;

  const missionDir = path.join(workbench, "missions", BOOK_QUALITY_MISSION_ID);
  if (!existsSync(missionDir)) return false;
  if (bookQualityMaintenancePassed(workbench)) return true;

  const progressPath = path.join(missionDir, "progress.md");
  if (existsSync(progressPath)) {
    let text = readFileSync(progressPath, "utf8");
    text = text.replace(/\|\s*(?:queued|in_progress)\s*\|/gi, "| done |");
    writeFileSync(progressPath, text, "utf8");
  }

  writeFileSync(
    path.join(missionDir, "checkpoint.md"),
    `# Checkpoint — ${BOOK_QUALITY_MISSION_ID}

STATUS: MAINTENANCE_PASS

## 状态
Programmatic quality maintenance scan PASS — all chapters ok (${scan.scannedAt})

`,
    "utf8",
  );
  return true;
}

export function readQualityScan(workbench: string): BookQualityScan | null {
  const p = qualityScanPath(workbench);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as BookQualityScan;
  } catch {
    return null;
  }
}

function patchQualityRubric(workbench: string, scan: BookQualityScan): boolean {
  const rubricPath = path.join(workbench, "missions", BOOK_MISSION_ID, "quality-rubric.md");
  if (!existsSync(rubricPath)) return false;
  if (!isMutationPathAllowed(workbench, rubricPath)) return false;

  let text = readFileSync(rubricPath, "utf8");
  const marker = "## 程序化门禁（self-optimize 自动追加）";
  if (text.includes(marker)) {
    text = text.split(marker)[0].trimEnd();
  }

  const spacedFails = scan.reports.filter((r) =>
    r.issues.some((i) => i.code === "spaced_bold"),
  ).length;

  const patch = [
    "",
    marker,
    "",
    "以下规则由 `pnpm self:optimize` 根据上次 scan 写入，fail → 自动 REVISE：",
    "",
    "7. **禁止 spaced-bold 凑字**：`** ** **`、字词间插入 `**` 计为 FAIL",
    "8. **review 不得仅凭 PASS 形容词**：须列出可 diff 的 must_fix",
    "9. **implement 后跑 quality-gate**：spaced_bold / han_bloat 触发 fix slot",
    "",
    `末次 scan：${scan.scannedAt}；失败章：${scan.failedChapters.join(", ") || "无"}；spaced-bold 章：${spacedFails}`,
    "",
  ].join("\n");

  writeFileSync(rubricPath, `${text}${patch}`, "utf8");
  return true;
}

export function runSelfOptimize(workbench: string): SelfOptimizeReport {
  const cfg = loadSelfOptimizeConfig(workbench);
  const autoQueueBookRevise = cfg.autoQueueBookRevise ?? true;
  if (cfg.enabled === false) {
    return {
      ranAt: new Date().toISOString(),
      autoQueueBookRevise,
      rubricPatched: false,
      mcpHintsWritten: false,
      recommendedActions: ["self-optimize disabled in config"],
    };
  }
  const recommendedActions: string[] = [];
  let qualityScan: BookQualityScan | undefined;
  let rubricPatched = false;

  // Validate the active selection before this tick writes any durable state.
  const activeWorkflowId = readActiveWorkflowSelection(workbench, BOOK_MISSION_ID);
  const workflowIds = listSearchableWorkflows();
  if (cfg.preferredBookWorkflow && !workflowIds.includes(cfg.preferredBookWorkflow)) {
    throw new Error(`Preferred workflow does not exist: ${cfg.preferredBookWorkflow}`);
  }
  const baselineWorkflowId =
    activeWorkflowId ?? (workflowIds.includes("axiom-book") ? "axiom-book" : "default");
  const baselineProfile = loadWorkflow(baselineWorkflowId).evalProfile;
  const eligibleWorkflowIds = workflowIds.filter(
    (workflowId) => loadWorkflow(workflowId).evalProfile === baselineProfile,
  );
  const bookCandidates = eligibleWorkflowIds.filter(
    (id) => id.includes("axiom") || id.includes("debate") || id === "default",
  );
  const pool = bookCandidates.length ? bookCandidates : eligibleWorkflowIds;
  const scored = pool
    .map((workflowId) => {
      const signals = workflowSignalsFromRuns(workbench, workflowId);
      return { ...scoreWorkflow(workflowId, signals), signals };
    })
    .sort((a, b) => b.score - a.score);
  const preferredIsEligible = cfg.preferredBookWorkflow === undefined ||
    eligibleWorkflowIds.includes(cfg.preferredBookWorkflow);
  const selectedId =
    (preferredIsEligible ? cfg.preferredBookWorkflow : undefined) ??
    scored.find((candidate) => candidate.workflowId !== baselineWorkflowId)?.workflowId ??
    baselineWorkflowId;
  const selectedSignals = workflowSignalsFromRuns(workbench, selectedId);
  const selectedScore = scoreWorkflow(selectedId, selectedSignals);
  const evidenceRuns = selectedSignals.sampleSize ?? 0;
  const workflowSelection = {
    workflowId: selectedId,
    baselineWorkflowId,
    score: selectedScore.score,
    reasons: selectedScore.reasons,
    evidenceRuns,
    active: false,
    experimentId: undefined as string | undefined,
    experimentStatus: undefined as "proposed" | undefined,
  };
  if (!preferredIsEligible && cfg.preferredBookWorkflow) {
    recommendedActions.push(
      `workflow: preferred ${cfg.preferredBookWorkflow} uses a different eval profile; keep ${baselineWorkflowId}`,
    );
    workflowSelection.workflowId = baselineWorkflowId;
    const baselineSignals = workflowSignalsFromRuns(workbench, baselineWorkflowId);
    const baselineScore = scoreWorkflow(baselineWorkflowId, baselineSignals);
    workflowSelection.score = baselineScore.score;
    workflowSelection.reasons = baselineScore.reasons;
    workflowSelection.evidenceRuns = baselineSignals.sampleSize ?? 0;
  } else if (selectedId !== baselineWorkflowId) {
    const proposal = proposeWorkflowExperiment(workbench, {
      targetMissionId: BOOK_MISSION_ID,
      baselineWorkflowId,
      candidateWorkflowId: selectedId,
      sourcePhaseId: "book-workflow-canary",
      requiredEpisodes: 2,
    });
    workflowSelection.experimentId = proposal.experimentId;
    workflowSelection.experimentStatus = "proposed";
    recommendedActions.push(
      `workflow: proposed ${selectedId} against ${baselineWorkflowId}; explicit canary required before activation (${proposal.experimentId})`,
    );
  } else {
    recommendedActions.push(`workflow: no distinct candidate available; keep ${baselineWorkflowId}`);
  }

  const bookDir = path.join(workbench, "missions", BOOK_MISSION_ID);
  if (existsSync(bookDir)) {
    qualityScan = scanBookQuality(workbench, {
      strictLength: cfg.strictChapterLength ?? false,
    });
    mkdirSync(path.join(workbench, "state"), { recursive: true });
    writeFileSync(qualityScanPath(workbench), `${JSON.stringify(qualityScan, null, 2)}\n`, "utf8");

    if (qualityScan.failedChapters.length > 0) {
      recommendedActions.push(
        `book_quality_revise: ${qualityScan.failedChapters.length} chapters — run pnpm book:quality-loop`,
      );
      for (const ch of qualityScan.failedChapters.slice(0, 5)) {
        const report = qualityScan.reports.find((r) => r.chapter === ch);
        if (report) {
          recommendedActions.push(...mustFixFromQualityReport(report).slice(0, 2));
        }
      }
    }
    rubricPatched = patchQualityRubric(workbench, qualityScan);
    if (qualityScan.failedChapters.length === 0) {
      syncBookQualityMissionComplete(workbench);
    }
  }

  const mcpHintsPath = path.join(workbench, "state", "mcp-hints.json");
  let mcpHintsWritten = false;
  if (isMutationPathAllowed(workbench, mcpHintsPath)) {
    writeMcpHints(workbench, { missionId: BOOK_MISSION_ID, repoRoot: "juno-overseer", provider: "openai_codex" });
    mcpHintsWritten = true;
    recommendedActions.push("mcp: refreshed state/mcp-hints.json from config/mcp-servers.json");
  }

  const report: SelfOptimizeReport = {
    ranAt: new Date().toISOString(),
    autoQueueBookRevise,
    qualityScan,
    workflowSelection,
    rubricPatched,
    mcpHintsWritten,
    recommendedActions,
  };

  writeFileSync(reportPath(workbench), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  try {
    recordEvolutionTick(workbench, { trigger: "self_optimize", note: "self-optimize tick" });
  } catch {
    /* best-effort */
  }
  return report;
}

export function hasPendingBookQualityFixes(workbench: string): boolean {
  const scan = readQualityScan(workbench);
  return (scan?.failedChapters.length ?? 0) > 0;
}

export function needsSelfOptimizeRun(workbench: string): boolean {
  const p = reportPath(workbench);
  if (!existsSync(p)) return true;
  try {
    const report = JSON.parse(readFileSync(p, "utf8")) as SelfOptimizeReport;
    const age = Date.now() - new Date(report.ranAt).getTime();
    if (age > 86_400_000) return true;
    const scan = readQualityScan(workbench);
    if (!scan) return true;
    return false;
  } catch {
    return true;
  }
}
