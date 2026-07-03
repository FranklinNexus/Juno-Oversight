/**
 * Von Neumann self-referential unit v0 — fitness, evolution log, mutation policy.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { todayAutonomyDate } from "./autonomy-day.js";
import { DEFAULT_AUTONOMY_LIMITS } from "./autonomy-types.js";

export interface EvolutionWeights {
  bookQuality: number;
  hardening: number;
  capUtilization: number;
  apiHealth: number;
  idlePenalty: number;
}

export interface EvolutionUnitConfig {
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
  hardening: 5,
  capUtilization: 2,
  apiHealth: 20,
  idlePenalty: 3,
};

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
  escalateOnBackoffDecline: true,
};

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
      detail: `fitness declining ${feedback.consecutiveDeclineDays}d + API backoff — check CURSOR_API_KEY / quota`,
    };
  }
  return { yes: false, feedback };
}

export function loadEvolutionConfig(workbench: string): EvolutionUnitConfig {
  const p = configPath(workbench);
  if (!existsSync(p)) {
    return {
      enabled: true,
      weights: DEFAULT_WEIGHTS,
      mutationAllowlist: DEFAULT_ALLOWLIST,
      mutationDenylist: DEFAULT_DENYLIST,
      plannerFeedback: { ...DEFAULT_PLANNER_FEEDBACK },
    };
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as EvolutionUnitConfig;
    return {
      enabled: raw.enabled !== false,
      weights: { ...DEFAULT_WEIGHTS, ...raw.weights },
      mutationAllowlist: raw.mutationAllowlist ?? DEFAULT_ALLOWLIST,
      mutationDenylist: raw.mutationDenylist ?? DEFAULT_DENYLIST,
      plannerFeedback: { ...DEFAULT_PLANNER_FEEDBACK, ...raw.plannerFeedback },
    };
  } catch {
    return { enabled: true, weights: DEFAULT_WEIGHTS, plannerFeedback: { ...DEFAULT_PLANNER_FEEDBACK } };
  }
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

function apiInBackoff(workbench: string): boolean {
  const p = path.join(workbench, "state", "api-quota.json");
  if (!existsSync(p)) return false;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as {
      providers?: { cursor?: { backoffUntil?: number } };
    };
    const until = raw.providers?.cursor?.backoffUntil ?? 0;
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
  };

  const score =
    components.bookQualityTerm +
    components.hardeningTerm +
    components.capTerm +
    components.apiHealthTerm +
    components.idlePenalty;

  return {
    scoredAt: new Date().toISOString(),
    autonomyDate: todayAutonomyDate(workbench),
    score: Math.round(score * 100) / 100,
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
  },
): EvolutionLogEntry {
  const prev = readEvolutionFitness(workbench);
  const snap = prev ?? computeEvolutionFitness(workbench);
  const score = entry.score ?? snap.score;
  const full: EvolutionLogEntry = {
    ts: new Date().toISOString(),
    autonomyDate: entry.autonomyDate ?? snap.autonomyDate,
    score,
    delta: prev ? Math.round((score - prev.score) * 100) / 100 : undefined,
    trigger: entry.trigger,
    action: entry.action,
    missionId: entry.missionId,
    note: entry.note,
  };
  mkdirSync(path.join(workbench, "state"), { recursive: true });
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
  const snap = computeEvolutionFitness(workbench, {
    idlePenaltyCount: opts.idlePenaltyCount,
  });
  writeEvolutionFitness(workbench, snap);
  appendEvolutionLog(workbench, {
    trigger: opts.trigger,
    action: opts.action,
    missionId: opts.missionId,
    score: snap.score,
    autonomyDate: snap.autonomyDate,
    note: opts.note,
  });
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
  if (repoRoot === "juno-overseer" && normalized.includes("orchestrator/src/")) {
    return true;
  }
  return false;
}
