/**
 * Extensible API gateway: rate limits, concurrency, backoff, token budgets.
 * Provider-agnostic — cursor_composer, api_token/openai, future providers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { workbenchRoot } from "./env.js";
import { todayAutonomyDate } from "./autonomy-day.js";
import type { RunManifest } from "./types.js";

export type ApiProviderId = "cursor" | "openai" | "anthropic" | "generic";

export interface ProviderLimitConfig {
  /** Minimum gap between request starts */
  minIntervalMs: number;
  maxRpm: number;
  maxRph: number;
  maxRpd: number;
  maxConcurrent: number;
  /** Soft daily token budget (0 = disabled) */
  tokenBudgetDaily: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface ApiLimitsConfig {
  providers: Record<string, Partial<ProviderLimitConfig>>;
  missions?: Record<
    string,
    { estimatedLiveSlots?: number; estimatedTokensPerSlot?: number; notes?: string }
  >;
}

export interface AcquireResult {
  ok: boolean;
  waitMs?: number;
  reason?: string;
  providerId?: ApiProviderId;
}

interface RequestRecord {
  ts: number;
  tokens?: number;
}

interface ProviderState {
  inflight: number;
  lastStartTs: number;
  backoffUntil: number;
  backoffStreak: number;
  requests: RequestRecord[];
  daily: { date: string; requests: number; tokens: number };
}

interface QuotaState {
  providers: Record<string, ProviderState>;
  updatedAt?: string;
}

const DEFAULT_LIMITS: Record<ApiProviderId, ProviderLimitConfig> = {
  cursor: {
    minIntervalMs: 8_000,
    maxRpm: 8,
    maxRph: 100,
    maxRpd: 400,
    maxConcurrent: 1,
    tokenBudgetDaily: 2_500_000,
    backoffBaseMs: 15_000,
    backoffMaxMs: 600_000,
  },
  openai: {
    minIntervalMs: 1_000,
    maxRpm: 60,
    maxRph: 500,
    maxRpd: 5_000,
    maxConcurrent: 2,
    tokenBudgetDaily: 0,
    backoffBaseMs: 5_000,
    backoffMaxMs: 120_000,
  },
  anthropic: {
    minIntervalMs: 1_000,
    maxRpm: 50,
    maxRph: 400,
    maxRpd: 4_000,
    maxConcurrent: 2,
    tokenBudgetDaily: 0,
    backoffBaseMs: 5_000,
    backoffMaxMs: 120_000,
  },
  generic: {
    minIntervalMs: 2_000,
    maxRpm: 30,
    maxRph: 300,
    maxRpd: 2_000,
    maxConcurrent: 1,
    tokenBudgetDaily: 0,
    backoffBaseMs: 10_000,
    backoffMaxMs: 300_000,
  },
};

function todayForQuota(workbench: string): string {
  return todayAutonomyDate(workbench);
}

function emptyProviderState(workbench: string): ProviderState {
  return {
    inflight: 0,
    lastStartTs: 0,
    backoffUntil: 0,
    backoffStreak: 0,
    requests: [],
    daily: { date: todayForQuota(workbench), requests: 0, tokens: 0 },
  };
}

export function readQuotaState(workbench: string): QuotaState {
  const p = quotaPath(workbench);
  if (!existsSync(p)) return { providers: {} };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as QuotaState;
  } catch {
    return { providers: {} };
  }
}

export function writeQuotaState(workbench: string, state: QuotaState): void {
  mkdirSync(path.dirname(quotaPath(workbench)), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(quotaPath(workbench), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function loadApiLimits(workbench: string): ApiLimitsConfig {
  const p = limitsConfigPath(workbench);
  if (!existsSync(p)) return { providers: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ApiLimitsConfig>;
    return { providers: raw.providers ?? {}, missions: raw.missions };
  } catch {
    return { providers: {} };
  }
}

export function resolveLimits(
  workbench: string,
  providerId: ApiProviderId,
): ProviderLimitConfig {
  const base = DEFAULT_LIMITS[providerId] ?? DEFAULT_LIMITS.generic;
  const cfg = loadApiLimits(workbench);
  const override = cfg.providers[providerId] ?? cfg.providers["*"] ?? {};
  return { ...base, ...override };
}

export function resolveProviderId(manifest: RunManifest): ApiProviderId {
  if (manifest.provider === "cursor_composer") return "cursor";
  if (manifest.provider === "api_token") {
    const ref = (manifest.providerRef ?? "openai").toLowerCase();
    if (ref.includes("anthropic")) return "anthropic";
    if (ref.includes("openai")) return "openai";
    return "generic";
  }
  return "generic";
}

function quotaPath(workbench: string): string {
  return path.join(workbench, "state", "api-quota.json");
}

function limitsConfigPath(workbench: string): string {
  return path.join(workbench, "config", "api-limits.json");
}

function getProviderState(state: QuotaState, workbench: string, providerId: ApiProviderId): ProviderState {
  if (!state.providers[providerId]) state.providers[providerId] = emptyProviderState(workbench);
  const ps = state.providers[providerId];
  const today = todayForQuota(workbench);
  if (ps.daily.date !== today) {
    ps.daily = { date: today, requests: 0, tokens: 0 };
  }
  pruneRequests(ps, Date.now());
  return ps;
}

function pruneRequests(ps: ProviderState, now: number): void {
  const dayAgo = now - 86_400_000;
  ps.requests = ps.requests.filter((r) => r.ts >= dayAgo);
}

function countSince(ps: ProviderState, windowMs: number, now: number): number {
  const cutoff = now - windowMs;
  return ps.requests.filter((r) => r.ts >= cutoff).length;
}

function computeWaitMs(
  limits: ProviderLimitConfig,
  ps: ProviderState,
  now: number,
  estimatedTokens: number,
): { ok: boolean; waitMs: number; reason?: string } {
  if (ps.backoffUntil > now) {
    return { ok: false, waitMs: ps.backoffUntil - now, reason: "provider_backoff" };
  }

  if (ps.inflight >= limits.maxConcurrent) {
    return { ok: false, waitMs: limits.minIntervalMs, reason: "max_concurrent" };
  }

  const sinceLast = now - ps.lastStartTs;
  if (ps.lastStartTs > 0 && sinceLast < limits.minIntervalMs) {
    return { ok: false, waitMs: limits.minIntervalMs - sinceLast, reason: "min_interval" };
  }

  const rpm = countSince(ps, 60_000, now);
  if (rpm >= limits.maxRpm) {
    const oldest = ps.requests.filter((r) => r.ts >= now - 60_000).sort((a, b) => a.ts - b.ts)[0];
    const waitMs = oldest ? 60_000 - (now - oldest.ts) + 250 : limits.minIntervalMs;
    return { ok: false, waitMs, reason: "max_rpm" };
  }

  const rph = countSince(ps, 3_600_000, now);
  if (rph >= limits.maxRph) {
    return { ok: false, waitMs: 60_000, reason: "max_rph" };
  }

  if (ps.daily.requests >= limits.maxRpd) {
    return { ok: false, waitMs: 3_600_000, reason: "max_rpd" };
  }

  if (
    limits.tokenBudgetDaily > 0 &&
    estimatedTokens > 0 &&
    ps.daily.tokens + estimatedTokens > limits.tokenBudgetDaily
  ) {
    return { ok: false, waitMs: 3_600_000, reason: "token_budget_daily" };
  }

  return { ok: true, waitMs: 0 };
}

export function acquireApiSlot(
  workbench: string,
  providerId: ApiProviderId,
  opts: { estimatedTokens?: number } = {},
): AcquireResult {
  const limits = resolveLimits(workbench, providerId);
  const state = readQuotaState(workbench);
  const ps = getProviderState(state, workbench, providerId);
  const now = Date.now();
  const check = computeWaitMs(limits, ps, now, opts.estimatedTokens ?? 0);

  if (!check.ok) {
    writeQuotaState(workbench, state);
    return {
      ok: false,
      waitMs: Math.max(250, check.waitMs ?? limits.minIntervalMs),
      reason: check.reason,
      providerId,
    };
  }

  ps.inflight += 1;
  ps.lastStartTs = now;
  ps.requests.push({ ts: now, tokens: opts.estimatedTokens });
  ps.daily.requests += 1;
  if (opts.estimatedTokens) ps.daily.tokens += opts.estimatedTokens;
  writeQuotaState(workbench, state);
  return { ok: true, providerId };
}

export function releaseApiSlot(workbench: string, providerId: ApiProviderId): void {
  const state = readQuotaState(workbench);
  const ps = getProviderState(state, workbench, providerId);
  ps.inflight = Math.max(0, ps.inflight - 1);
  writeQuotaState(workbench, state);
}

export function recordApiSuccess(
  workbench: string,
  providerId: ApiProviderId,
  meta: { tokens?: number; latencyMs?: number } = {},
): void {
  const state = readQuotaState(workbench);
  const ps = getProviderState(state, workbench, providerId);
  ps.backoffStreak = 0;
  ps.backoffUntil = 0;
  if (meta.tokens && meta.tokens > 0) {
    const last = ps.requests[ps.requests.length - 1];
    const prevEstimate = last?.tokens ?? 0;
    if (last) last.tokens = meta.tokens;
    ps.daily.tokens += Math.max(0, meta.tokens - prevEstimate);
  }
  writeQuotaState(workbench, state);
}

export function recordApiFailure(
  workbench: string,
  providerId: ApiProviderId,
  err: { httpStatus?: number; retryAfterMs?: number; retryable?: boolean; message?: string },
): AcquireResult {
  const limits = resolveLimits(workbench, providerId);
  const state = readQuotaState(workbench);
  const ps = getProviderState(state, workbench, providerId);
  ps.backoffStreak += 1;

  let waitMs = err.retryAfterMs ?? 0;
  if (err.httpStatus === 429 || err.retryable) {
    if (!waitMs) {
      waitMs = Math.min(
        limits.backoffMaxMs,
        limits.backoffBaseMs * 2 ** Math.min(ps.backoffStreak - 1, 6),
      );
    }
    waitMs += Math.floor(Math.random() * 2000);
  } else if (err.httpStatus && err.httpStatus >= 500) {
    waitMs = Math.min(limits.backoffMaxMs, limits.backoffBaseMs * ps.backoffStreak);
  }

  if (waitMs > 0) {
    ps.backoffUntil = Date.now() + waitMs;
    writeQuotaState(workbench, state);
    return { ok: false, waitMs, reason: "api_error_backoff", providerId };
  }

  writeQuotaState(workbench, state);
  return { ok: true, providerId };
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForApiSlot(
  workbench: string,
  providerId: ApiProviderId,
  opts: { estimatedTokens?: number; maxWaitMs?: number } = {},
): Promise<AcquireResult> {
  const maxWait = opts.maxWaitMs ?? 600_000;
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    const r = acquireApiSlot(workbench, providerId, { estimatedTokens: opts.estimatedTokens });
    if (r.ok) return r;
    const wait = Math.min(r.waitMs ?? 5000, deadline - Date.now());
    if (wait <= 0) break;
    await sleepMs(wait);
  }
  return { ok: false, waitMs: 0, reason: "wait_timeout", providerId };
}

/** Rough token estimate for capacity planning */
export function estimateManifestTokens(manifest: RunManifest): number {
  const kind = manifest.runKind ?? "implement";
  if (manifest.provider === "cursor_composer") {
    if (kind === "implement" && manifest.phaseId?.includes("ch") && manifest.phaseId.includes("write")) {
      return 35_000;
    }
    if (kind === "review") return 18_000;
    if (kind === "debate") return 22_000;
    return 12_000;
  }
  return 8_000;
}

export interface MissionCapacityReport {
  missionId: string;
  liveSlots: number;
  tokensPerSlot: number;
  totalTokens: number;
  estimatedWallHours: number;
  providers: Record<string, { limits: ProviderLimitConfig; dailyCapacityRequests: number }>;
}

export function estimateMissionCapacity(
  workbench: string,
  missionId: string,
): MissionCapacityReport | null {
  const cfg = loadApiLimits(workbench);
  const mission = cfg.missions?.[missionId];
  if (!mission) return null;
  const liveSlots = mission.estimatedLiveSlots ?? 0;
  const tokensPerSlot = mission.estimatedTokensPerSlot ?? 25_000;
  const limits = resolveLimits(workbench, "cursor");
  return {
    missionId,
    liveSlots,
    tokensPerSlot,
    totalTokens: liveSlots * tokensPerSlot,
    estimatedWallHours: (liveSlots * 35) / 60,
    providers: {
      cursor: {
        limits,
        dailyCapacityRequests: limits.maxRpd,
      },
    },
  };
}

export interface QuotaStatusRow {
  providerId: string;
  inflight: number;
  rpm: number;
  rph: number;
  dailyRequests: number;
  dailyTokens: number;
  backoffUntil: string | null;
  limits: ProviderLimitConfig;
}

export function getQuotaStatus(workbench: string = workbenchRoot()): QuotaStatusRow[] {
  const state = readQuotaState(workbench);
  const now = Date.now();
  const rows: QuotaStatusRow[] = [];
  for (const providerId of Object.keys(DEFAULT_LIMITS) as ApiProviderId[]) {
    const ps = state.providers[providerId];
    if (!ps && providerId !== "cursor") continue;
    const p = ps ?? emptyProviderState(workbench);
    pruneRequests(p, now);
    const limits = resolveLimits(workbench, providerId);
    rows.push({
      providerId,
      inflight: p.inflight,
      rpm: countSince(p, 60_000, now),
      rph: countSince(p, 3_600_000, now),
      dailyRequests: p.daily.requests,
      dailyTokens: p.daily.tokens,
      backoffUntil: p.backoffUntil > now ? new Date(p.backoffUntil).toISOString() : null,
      limits,
    });
  }
  return rows;
}

export function parseHttpRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const sec = Number(raw);
  if (!Number.isNaN(sec)) return sec * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
