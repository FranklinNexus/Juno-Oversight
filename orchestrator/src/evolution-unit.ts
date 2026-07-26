/**
 * Von Neumann self-referential unit v0 — fitness, evolution log, mutation policy.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { todayAutonomyDate } from "./autonomy-day.js";
import { DEFAULT_AUTONOMY_LIMITS } from "./autonomy-types.js";
import { observeRunOutcome } from "./run-outcome.js";
import type { RunKind } from "./types.js";

export interface EvolutionWeights {
  bookQuality: number;
  hardening: number;
  capUtilization: number;
  apiHealth: number;
  idlePenalty: number;
  runSuccess: number;
  verifyPass: number;
  runFailure: number;
  revisePenalty: number;
  safetyBlock: number;
}

export interface EvolutionUnitConfig {
  /** v2 removes activity-based rewards from fitness. */
  schemaVersion?: 2;
  enabled?: boolean;
  weights?: Partial<EvolutionWeights>;
  /** Paths (relative to workbench or repo) that genotype mutation may touch without human */
  mutationAllowlist?: string[];
  /** Never self-modify even with agent write access */
  mutationDenylist?: string[];
  /** v1: fitness signals feed back into mission-planner */
  plannerFeedback?: {
    enabled?: boolean;
    /** Rolling window for daily average (days) */
    rollingDays?: number;
    /** Consecutive declining days before self-optimize trigger */
    declineThresholdDays?: number;
    /** Min distinct daily scores before trend is evaluated */
    minDailyScores?: number;
    /** Trigger self-optimize on sustained decline */
    selfOptimizeOnDecline?: boolean;
    /** Minimum time between repeated mutations for the same declining window. */
    selfOptimizeCooldownHours?: number;
    /** Escalate when decline + API backoff together */
    escalateOnBackoffDecline?: boolean;
  };
}

export interface EvolutionFitnessComponents {
  bookQualityTerm: number;
  hardeningTerm: number;
  capTerm: number;
  apiHealthTerm: number;
  idlePenalty: number;
  failedChapters: number;
  hardeningPhasesDone: number;
  iterationsToday: number;
  maxIterationsPerDay: number;
  apiInBackoff: boolean;
  runSuccessTerm: number;
  verifyPassTerm: number;
  runFailureTerm: number;
  reviseTerm: number;
  safetyTerm: number;
  completedRuns: number;
  failedRuns: number;
  verifyPasses: number;
  verifyFailures: number;
  revisions: number;
  safetyBlocks: number;
}

export interface EvolutionFitnessSnapshot {
  scoredAt: string;
  autonomyDate: string;
  score: number;
  components: EvolutionFitnessComponents;
  lastPlannerAction?: string;
  lastMissionId?: string;
}

export interface EvolutionLogEntry {
  ts: string;
  autonomyDate: string;
  score: number;
  delta?: number;
  trigger: "autonomy_tick" | "self_optimize" | "manual";
  action?: string;
  missionId?: string;
  note?: string;
}

export interface EvolutionFeedback {
  evaluatedAt: string;
  dailyScores: Array<{ date: string; score: number }>;
  rollingMa7: number | null;
  trend: "ok" | "declining" | "insufficient_data";
  consecutiveDeclineDays: number;
  apiInBackoff: boolean;
}

const DEFAULT_WEIGHTS: EvolutionWeights = {
  bookQuality: 10,
  hardening: 0,
  capUtilization: 0,
  apiHealth: 20,
  idlePenalty: 3,
  runSuccess: 25,
  verifyPass: 20,
  runFailure: 30,
  revisePenalty: 10,
  safetyBlock: 25,
};

const FITNESS_BASELINE = 50;

const DEFAULT_DENYLIST = [
  "config/autonomy-charter.json",
  "Vault",
  ".git",
  "git push --force",
  "git reset --hard",
];

const DEFAULT_ALLOWLIST = [
  "config/mission-registry.json",
  "config/self-optimize.json",
  "config/mcp-servers.json",
  "config/model-defaults.json",
  "state/mcp-hints.json",
  "state/workflow-selection.json",
  "missions/juno-axiom-book-2026/quality-rubric.md",
];

/** Parse hardening progress.md table — count rows with Status column = done. */
export function countHardeningPhasesDone(workbench: string): number {
  const progress = path.join(workbench, "missions", "juno-overseer-hardening-2026", "progress.md");
  if (!existsSync(progress)) return 0;
  const text = readFileSync(progress, "utf8");
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || trimmed.startsWith("|--") || trimmed.startsWith("| Phase")) {
      continue;
    }
    const cols = trimmed
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cols.length >= 3 && /^done$/i.test(cols[2])) count += 1;
  }
  return count;
}

function configPath(workbench: string): string {
  return path.join(workbench, "config", "evolution-unit.json");
}

function fitnessPath(workbench: string): string {
  return path.join(workbench, "state", "evolution-fitness.json");
}

function logPath(workbench: string): string {
  return path.join(workbench, "state", "evolution-log.jsonl");
}

function feedbackPath(workbench: string): string {
  return path.join(workbench, "state", "evolution-feedback.json");
}

const DEFAULT_PLANNER_FEEDBACK = {
  enabled: true,
  rollingDays: 7,
  declineThresholdDays: 3,
  minDailyScores: 2,
  selfOptimizeOnDecline: true,
  selfOptimizeCooldownHours: 24,
  escalateOnBackoffDecline: true,
};

function normalizeEvolutionWeights(weights?: Partial<EvolutionWeights>): EvolutionWeights {
  return {
    ...DEFAULT_WEIGHTS,
    ...weights,
    // These legacy dimensions reward activity/history rather than task outcomes.
    hardening: 0,
    capUtilization: 0,
  };
}

export function readEvolutionLogEntries(workbench: string): EvolutionLogEntry[] {
  const p = logPath(workbench);
  if (!existsSync(p)) return [];
  const entries: EvolutionLogEntry[] = [];
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as EvolutionLogEntry);
    } catch {
      /* skip bad line */
    }
  }
  return entries;
}

export function dailyScoresFromLog(workbench: string): Array<{ date: string; score: number }> {
  const byDate = new Map<string, EvolutionLogEntry>();
  for (const entry of readEvolutionLogEntries(workbench)) {
    if (!entry.autonomyDate || typeof entry.score !== "number") continue;
    const prev = byDate.get(entry.autonomyDate);
    if (!prev || entry.ts >= prev.ts) byDate.set(entry.autonomyDate, entry);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, e]) => ({ date, score: e.score }));
}

export function evaluateEvolutionFeedback(workbench: string): EvolutionFeedback {
  const cfg = loadEvolutionConfig(workbench);
  const pf = { ...DEFAULT_PLANNER_FEEDBACK, ...cfg.plannerFeedback };
  const dailyScores = dailyScoresFromLog(workbench);
  const backoff = apiInBackoff(workbench);

  if (dailyScores.length < (pf.minDailyScores ?? 2)) {
    return {
      evaluatedAt: new Date().toISOString(),
      dailyScores,
      rollingMa7: null,
      trend: "insufficient_data",
      consecutiveDeclineDays: 0,
      apiInBackoff: backoff,
    };
  }

  const window = dailyScores.slice(-(pf.rollingDays ?? 7));
  const rollingMa7 =
    window.length > 0
      ? Math.round((window.reduce((s, d) => s + d.score, 0) / window.length) * 100) / 100
      : null;

  let consecutiveDeclineDays = 0;
  for (let i = dailyScores.length - 1; i > 0; i--) {
    if (dailyScores[i].score < dailyScores[i - 1].score) consecutiveDeclineDays += 1;
    else break;
  }

  const threshold = pf.declineThresholdDays ?? 3;
  const trend = consecutiveDeclineDays >= threshold ? "declining" : "ok";

  return {
    evaluatedAt: new Date().toISOString(),
    dailyScores,
    rollingMa7,
    trend,
    consecutiveDeclineDays,
    apiInBackoff: backoff,
  };
}

export function writeEvolutionFeedback(workbench: string, feedback: EvolutionFeedback): void {
  mkdirSync(path.join(workbench, "state"), { recursive: true });
  writeFileSync(feedbackPath(workbench), `${JSON.stringify(feedback, null, 2)}\n`, "utf8");
}

export function shouldSelfOptimizeForFitness(workbench: string): {
  yes: boolean;
  feedback: EvolutionFeedback;
  reason?: string;
} {
  const cfg = loadEvolutionConfig(workbench);
  if (cfg.enabled === false || cfg.plannerFeedback?.enabled === false) {
    return { yes: false, feedback: evaluateEvolutionFeedback(workbench) };
  }
  const pf = { ...DEFAULT_PLANNER_FEEDBACK, ...cfg.plannerFeedback };
  const feedback = evaluateEvolutionFeedback(workbench);
  writeEvolutionFeedback(workbench, feedback);

  if (feedback.trend !== "declining" || pf.selfOptimizeOnDecline === false) {
    return { yes: false, feedback };
  }

  const cooldownMs = Math.max(0, pf.selfOptimizeCooldownHours ?? 24) * 60 * 60 * 1000;
  const lastMutation = readEvolutionLogEntries(workbench)
    .slice()
    .reverse()
    .find((entry) => entry.trigger === "self_optimize");
  if (lastMutation && cooldownMs > 0) {
    const elapsedMs = Date.now() - Date.parse(lastMutation.ts);
    if (Number.isFinite(elapsedMs) && elapsedMs < cooldownMs) {
      return {
        yes: false,
        feedback,
        reason: `self-optimize cooldown active since ${lastMutation.ts}`,
      };
    }
  }
  return {
    yes: true,
    feedback,
    reason: `fitness declining ${feedback.consecutiveDeclineDays}d (ma7=${feedback.rollingMa7 ?? "n/a"})`,
  };
}

export function shouldEscalateForFitness(workbench: string): {
  yes: boolean;
  feedback: EvolutionFeedback;
  detail?: string;
} {
  const cfg = loadEvolutionConfig(workbench);
  if (cfg.enabled === false || cfg.plannerFeedback?.enabled === false) {
    return { yes: false, feedback: evaluateEvolutionFeedback(workbench) };
  }
  const pf = { ...DEFAULT_PLANNER_FEEDBACK, ...cfg.plannerFeedback };
  const feedback = evaluateEvolutionFeedback(workbench);
  writeEvolutionFeedback(workbench, feedback);

  if (
    pf.escalateOnBackoffDecline !== false &&
    feedback.trend === "declining" &&
    feedback.apiInBackoff
  ) {
    return {
      yes: true,
      feedback,
      detail: `fitness declining ${feedback.consecutiveDeclineDays}d + provider backoff — check provider health`,
    };
  }
  return { yes: false, feedback };
}

export function loadEvolutionConfig(workbench: string): EvolutionUnitConfig {
  const p = configPath(workbench);
  if (!existsSync(p)) {
    return {
      schemaVersion: 2,
      enabled: true,
      weights: normalizeEvolutionWeights(),
      mutationAllowlist: DEFAULT_ALLOWLIST,
      mutationDenylist: DEFAULT_DENYLIST,
      plannerFeedback: { ...DEFAULT_PLANNER_FEEDBACK },
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (error) {
    throw new Error(`Evolution config is unreadable; refusing self-mutation: ${p}`, {
      cause: error,
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Evolution config must be a JSON object: ${p}`);
  }
  const config = raw as EvolutionUnitConfig;
  const weightValues = Object.values(config.weights ?? {});
  const feedback = config.plannerFeedback ?? {};
  const feedbackIntegers = [
    feedback.rollingDays,
    feedback.declineThresholdDays,
    feedback.minDailyScores,
  ].filter((value) => value !== undefined);
  const feedbackBooleans = [
    feedback.enabled,
    feedback.selfOptimizeOnDecline,
    feedback.escalateOnBackoffDecline,
  ].filter((value) => value !== undefined);
  if (
    (config.schemaVersion !== undefined && config.schemaVersion !== 2) ||
    (config.enabled !== undefined && typeof config.enabled !== "boolean") ||
    weightValues.some(
      (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0,
    ) ||
    (config.mutationAllowlist !== undefined &&
      (!Array.isArray(config.mutationAllowlist) ||
        config.mutationAllowlist.some((entry) => typeof entry !== "string" || !entry.trim()))) ||
    (config.mutationDenylist !== undefined &&
      (!Array.isArray(config.mutationDenylist) ||
        config.mutationDenylist.some((entry) => typeof entry !== "string" || !entry.trim()))) ||
    feedbackIntegers.some(
      (value) => typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0,
    ) ||
    (feedback.selfOptimizeCooldownHours !== undefined &&
      (typeof feedback.selfOptimizeCooldownHours !== "number" ||
        !Number.isFinite(feedback.selfOptimizeCooldownHours) ||
        feedback.selfOptimizeCooldownHours < 0)) ||
    feedbackBooleans.some((value) => typeof value !== "boolean")
  ) {
    throw new Error(`Evolution config contains invalid control fields: ${p}`);
  }
  return {
    schemaVersion: 2,
    enabled: config.enabled !== false,
    weights: normalizeEvolutionWeights(config.weights),
    mutationAllowlist: config.mutationAllowlist ?? DEFAULT_ALLOWLIST,
    mutationDenylist: config.mutationDenylist ?? DEFAULT_DENYLIST,
    plannerFeedback: { ...DEFAULT_PLANNER_FEEDBACK, ...feedback },
  };
}

function readQualityScanInline(workbench: string): { failedChapters: number[] } | null {
  const p = path.join(workbench, "state", "quality-scan.json");
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { failedChapters?: number[] };
    return { failedChapters: raw.failedChapters ?? [] };
  } catch {
    return null;
  }
}

function readAutonomySnapshot(workbench: string): {
  iterationsToday: number;
  lastAction?: string;
  lastMissionId?: string;
} {
  const p = path.join(workbench, "state", "bounded-autonomy.json");
  const today = todayAutonomyDate(workbench);
  if (!existsSync(p)) {
    return { iterationsToday: 0 };
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as {
      date?: string;
      iterationsToday?: number;
      lastAction?: string;
      lastMissionId?: string;
    };
    if (raw.date !== today) return { iterationsToday: 0 };
    return {
      iterationsToday: raw.iterationsToday ?? 0,
      lastAction: raw.lastAction,
      lastMissionId: raw.lastMissionId,
    };
  } catch {
    return { iterationsToday: 0 };
  }
}

export interface RunOutcomeMetrics {
  completedRuns: number;
  failedRuns: number;
  verifyPasses: number;
  verifyFailures: number;
  revisions: number;
  safetyBlocks: number;
}

/** Aggregate actual terminal run outcomes; newest runs are used to keep fitness responsive. */
export function readRunOutcomeMetrics(workbench: string, maxRuns = 100): RunOutcomeMetrics {
  const metrics: RunOutcomeMetrics = {
    completedRuns: 0,
    failedRuns: 0,
    verifyPasses: 0,
    verifyFailures: 0,
    revisions: 0,
    safetyBlocks: 0,
  };
  const runsDir = path.join(workbench, "runs");
  if (!existsSync(runsDir)) return metrics;

  const runs = readdirSync(runsDir)
    .map((name) => path.join(runsDir, name))
    .filter((runDir) => {
      try {
        return statSync(runDir).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, maxRuns);

  for (const runDir of runs) {
    let runKind: RunKind = "implement";
    try {
      const manifest = JSON.parse(readFileSync(path.join(runDir, "manifest.json"), "utf8")) as {
        runKind?: RunKind;
      };
      runKind = manifest.runKind ?? runKind;
    } catch {
      continue;
    }

    let lastStatus = "";
    try {
      const state = JSON.parse(readFileSync(path.join(runDir, "run-state.json"), "utf8")) as {
        lastStatus?: string;
      };
      lastStatus = state.lastStatus ?? "";
    } catch {
      /* a checkpoint may still provide terminal evidence */
    }

    const checkpointPath = path.join(runDir, "checkpoint.md");
    const checkpoint = existsSync(checkpointPath) ? readFileSync(checkpointPath, "utf8") : "";
    const safetyPath = path.join(runDir, "safety-verify.md");
    const safety = existsSync(safetyPath) ? readFileSync(safetyPath, "utf8") : "";
    const outcome = observeRunOutcome(runKind, lastStatus, checkpoint, safety);
    if (outcome.success) metrics.completedRuns += 1;
    if (outcome.failure) metrics.failedRuns += 1;
    if (outcome.verifyPass) metrics.verifyPasses += 1;
    if (outcome.verifyFail) metrics.verifyFailures += 1;
    if (outcome.revised) metrics.revisions += 1;
    if (outcome.safetyBlocked) metrics.safetyBlocks += 1;
  }

  return metrics;
}

function apiInBackoff(workbench: string): boolean {
  const p = path.join(workbench, "state", "api-quota.json");
  if (!existsSync(p)) return false;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as {
      providers?: { openai?: { backoffUntil?: number } };
    };
    const until = raw.providers?.openai?.backoffUntil ?? 0;
    return until > Date.now();
  } catch {
    return false;
  }
}

export function computeEvolutionFitness(
  workbench: string,
  opts: { idlePenaltyCount?: number; maxIterationsPerDay?: number } = {},
): EvolutionFitnessSnapshot {
  const cfg = loadEvolutionConfig(workbench);
  const w = { ...DEFAULT_WEIGHTS, ...cfg.weights };
  const scan = readQualityScanInline(workbench);
  const failed = scan?.failedChapters.length ?? 0;
  const hardeningDone = countHardeningPhasesDone(workbench);
  const autonomy = readAutonomySnapshot(workbench);
  const maxDay = opts.maxIterationsPerDay ?? DEFAULT_AUTONOMY_LIMITS.maxSelfIterationsPerDay;
  const capRatio = maxDay > 0 ? autonomy.iterationsToday / maxDay : 0;
  const backoff = apiInBackoff(workbench);
  const idleN = opts.idlePenaltyCount ?? 0;
  const outcomes = readRunOutcomeMetrics(workbench);
  const terminalRuns = outcomes.completedRuns + outcomes.failedRuns;
  const verifyRuns = outcomes.verifyPasses + outcomes.verifyFailures;
  const successRate = terminalRuns > 0 ? outcomes.completedRuns / terminalRuns : 0;
  const failureRate = terminalRuns > 0 ? outcomes.failedRuns / terminalRuns : 0;
  const verifyPassRate = verifyRuns > 0 ? outcomes.verifyPasses / verifyRuns : 0;
  const reviseRate = terminalRuns > 0 ? outcomes.revisions / terminalRuns : 0;

  const components: EvolutionFitnessComponents = {
    bookQualityTerm: -w.bookQuality * failed,
    hardeningTerm: w.hardening * hardeningDone,
    capTerm: w.capUtilization * capRatio,
    apiHealthTerm: backoff ? -w.apiHealth : 0,
    idlePenalty: -w.idlePenalty * idleN,
    failedChapters: failed,
    hardeningPhasesDone: hardeningDone,
    iterationsToday: autonomy.iterationsToday,
    maxIterationsPerDay: maxDay,
    apiInBackoff: backoff,
    runSuccessTerm: w.runSuccess * successRate,
    verifyPassTerm: w.verifyPass * verifyPassRate,
    runFailureTerm: -w.runFailure * failureRate,
    reviseTerm: -w.revisePenalty * reviseRate,
    safetyTerm: -w.safetyBlock * Math.min(1, outcomes.safetyBlocks),
    ...outcomes,
  };

  const score =
    FITNESS_BASELINE +
    components.bookQualityTerm +
    components.hardeningTerm +
    components.capTerm +
    components.apiHealthTerm +
    components.idlePenalty +
    components.runSuccessTerm +
    components.verifyPassTerm +
    components.runFailureTerm +
    components.reviseTerm +
    components.safetyTerm;

  return {
    scoredAt: new Date().toISOString(),
    autonomyDate: todayAutonomyDate(workbench),
    score: Math.max(0, Math.min(100, Math.round(score * 100) / 100)),
    components,
    lastPlannerAction: autonomy.lastAction,
    lastMissionId: autonomy.lastMissionId,
  };
}

export function writeEvolutionFitness(workbench: string, snapshot: EvolutionFitnessSnapshot): void {
  mkdirSync(path.join(workbench, "state"), { recursive: true });
  writeFileSync(fitnessPath(workbench), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export function readEvolutionFitness(workbench: string): EvolutionFitnessSnapshot | null {
  const p = fitnessPath(workbench);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as EvolutionFitnessSnapshot;
  } catch {
    return null;
  }
}

export function appendEvolutionLog(
  workbench: string,
  entry: Omit<EvolutionLogEntry, "ts" | "autonomyDate" | "score"> & {
    score?: number;
    autonomyDate?: string;
    previousScore?: number;
  },
): EvolutionLogEntry {
  const prev = readEvolutionFitness(workbench);
  const snap = prev ?? computeEvolutionFitness(workbench);
  const score = entry.score ?? snap.score;
  const previousScore = entry.previousScore ?? prev?.score;
  const full: EvolutionLogEntry = {
    ts: new Date().toISOString(),
    autonomyDate: entry.autonomyDate ?? snap.autonomyDate,
    score,
    delta:
      previousScore != null
        ? Math.round((score - previousScore) * 100) / 100
        : undefined,
    trigger: entry.trigger,
    action: entry.action,
    missionId: entry.missionId,
    note: entry.note,
  };
  mkdirSync(path.join(workbench, "state"), { recursive: true });
  const latest = readEvolutionLogEntries(workbench).at(-1);
  if (
    latest &&
    latest.autonomyDate === full.autonomyDate &&
    latest.score === full.score &&
    latest.trigger === full.trigger &&
    latest.action === full.action &&
    latest.missionId === full.missionId &&
    latest.note === full.note
  ) {
    return latest;
  }
  appendFileSync(logPath(workbench), `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

/** Score + persist + log — call after autonomy tick or self-optimize. */
export function recordEvolutionTick(
  workbench: string,
  opts: {
    trigger: EvolutionLogEntry["trigger"];
    action?: string;
    missionId?: string;
    idlePenaltyCount?: number;
    note?: string;
  },
): EvolutionFitnessSnapshot {
  const previous = readEvolutionFitness(workbench);
  const snap = computeEvolutionFitness(workbench, {
    idlePenaltyCount: opts.idlePenaltyCount,
  });
  appendEvolutionLog(workbench, {
    trigger: opts.trigger,
    action: opts.action,
    missionId: opts.missionId,
    score: snap.score,
    autonomyDate: snap.autonomyDate,
    previousScore: previous?.score,
    note: opts.note,
  });
  writeEvolutionFitness(workbench, snap);
  return snap;
}

export function isMutationPathAllowed(
  workbench: string,
  targetPath: string,
  repoRoot?: string,
): boolean {
  const cfg = loadEvolutionConfig(workbench);
  const normalized = targetPath.replace(/\\/g, "/").toLowerCase();
  for (const deny of cfg.mutationDenylist ?? DEFAULT_DENYLIST) {
    if (normalized.includes(deny.toLowerCase().replace(/\\/g, "/"))) return false;
  }
  for (const allow of cfg.mutationAllowlist ?? DEFAULT_ALLOWLIST) {
    const a = allow.toLowerCase().replace(/\\/g, "/");
    if (normalized.includes(a)) return true;
  }
  void repoRoot;
  return false;
}
