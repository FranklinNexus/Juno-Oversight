/**
 * Extensible API gateway: rate limits, concurrency, backoff, token budgets.
 * Provider-agnostic rate, concurrency, and budget gate for live executors.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { workbenchRoot } from "./env.js";
import { todayAutonomyDate } from "./autonomy-day.js";
import type { RunManifest } from "./types.js";

export type ApiProviderId = "openai" | "anthropic" | "generic";

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
  leaseId?: string;
}

interface RequestRecord {
  id?: string;
  ts: number;
  tokens?: number;
}

interface ProviderLease {
  id: string;
  pid: number;
  expiresAt: number;
}

interface ProviderState {
  inflight: number;
  lastStartTs: number;
  backoffUntil: number;
  backoffStreak: number;
  leases?: ProviderLease[];
  requests: RequestRecord[];
  daily: { date: string; requests: number; tokens: number };
}

interface QuotaState {
  providers: Record<string, ProviderState>;
  updatedAt?: string;
}

const DEFAULT_LIMITS: Record<ApiProviderId, ProviderLimitConfig> = {
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

const LIMIT_NUMBER_RULES: Record<
  keyof ProviderLimitConfig,
  { min: number; integer: boolean }
> = {
  minIntervalMs: { min: 0, integer: true },
  maxRpm: { min: 1, integer: true },
  maxRph: { min: 1, integer: true },
  maxRpd: { min: 1, integer: true },
  maxConcurrent: { min: 1, integer: true },
  tokenBudgetDaily: { min: 0, integer: true },
  backoffBaseMs: { min: 1, integer: true },
  backoffMaxMs: { min: 1, integer: true },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFiniteNumber(
  value: unknown,
  label: string,
  rule: { min: number; integer: boolean },
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < rule.min ||
    (rule.integer && !Number.isInteger(value))
  ) {
    throw new Error(
      `Invalid ${label}: expected ${rule.integer ? "an integer" : "a number"} >= ${rule.min}`,
    );
  }
}

function validateApiLimitsConfig(raw: unknown, target: string): ApiLimitsConfig {
  if (!isRecord(raw)) throw new Error(`Invalid API limits config: ${target}`);
  const providers = raw.providers ?? {};
  if (!isRecord(providers)) {
    throw new Error(`Invalid API limits config providers: ${target}`);
  }
  for (const [providerId, override] of Object.entries(providers)) {
    if (!isRecord(override)) {
      throw new Error(`Invalid API limits config provider ${providerId}: ${target}`);
    }
    for (const [key, rule] of Object.entries(LIMIT_NUMBER_RULES) as Array<
      [keyof ProviderLimitConfig, { min: number; integer: boolean }]
    >) {
      if (key in override) assertFiniteNumber(override[key], `${providerId}.${key}`, rule);
    }
  }

  const missions = raw.missions;
  if (missions !== undefined) {
    if (!isRecord(missions)) throw new Error(`Invalid API limits missions: ${target}`);
    for (const [missionId, mission] of Object.entries(missions)) {
      if (!isRecord(mission)) {
        throw new Error(`Invalid API limits mission ${missionId}: ${target}`);
      }
      for (const key of ["estimatedLiveSlots", "estimatedTokensPerSlot"] as const) {
        if (key in mission) {
          assertFiniteNumber(mission[key], `${missionId}.${key}`, { min: 0, integer: true });
        }
      }
      if (mission.notes !== undefined && typeof mission.notes !== "string") {
        throw new Error(`Invalid API limits mission ${missionId}.notes: ${target}`);
      }
    }
  }

  return {
    providers: providers as ApiLimitsConfig["providers"],
    missions: missions as ApiLimitsConfig["missions"],
  };
}

function todayForQuota(workbench: string): string {
  return todayAutonomyDate(workbench);
}

function emptyProviderState(workbench: string): ProviderState {
  return {
    inflight: 0,
    lastStartTs: 0,
    backoffUntil: 0,
    backoffStreak: 0,
    leases: [],
    requests: [],
    daily: { date: todayForQuota(workbench), requests: 0, tokens: 0 },
  };
}

export function readQuotaState(workbench: string): QuotaState {
  return readQuotaStateStrict(workbench);
}

export function writeQuotaState(workbench: string, state: QuotaState): void {
  mkdirSync(path.dirname(quotaPath(workbench)), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const target = quotaPath(workbench);
  validateQuotaState(state, target);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

function validateQuotaState(raw: unknown, target: string): asserts raw is QuotaState {
  if (!isRecord(raw) || !isRecord(raw.providers)) {
    throw new Error(`Invalid API quota state: ${target}`);
  }
  if (raw.updatedAt !== undefined && typeof raw.updatedAt !== "string") {
    throw new Error(`Invalid API quota state updatedAt: ${target}`);
  }

  for (const [providerId, value] of Object.entries(raw.providers)) {
    if (!isRecord(value)) {
      throw new Error(`Invalid API quota provider ${providerId}: ${target}`);
    }
    assertFiniteNumber(value.inflight, `${providerId}.inflight`, { min: 0, integer: true });
    assertFiniteNumber(value.lastStartTs, `${providerId}.lastStartTs`, {
      min: 0,
      integer: true,
    });
    assertFiniteNumber(value.backoffUntil, `${providerId}.backoffUntil`, {
      min: 0,
      integer: true,
    });
    assertFiniteNumber(value.backoffStreak, `${providerId}.backoffStreak`, {
      min: 0,
      integer: true,
    });

    if (!Array.isArray(value.requests)) {
      throw new Error(`Invalid API quota requests for ${providerId}: ${target}`);
    }
    const requestIds = new Set<string>();
    for (const [index, request] of value.requests.entries()) {
      if (!isRecord(request)) {
        throw new Error(`Invalid API quota request ${providerId}[${index}]: ${target}`);
      }
      assertFiniteNumber(request.ts, `${providerId}.requests[${index}].ts`, {
        min: 0,
        integer: true,
      });
      if (request.tokens !== undefined) {
        assertFiniteNumber(request.tokens, `${providerId}.requests[${index}].tokens`, {
          min: 0,
          integer: true,
        });
      }
      if (request.id !== undefined) {
        if (typeof request.id !== "string" || request.id.length === 0 || requestIds.has(request.id)) {
          throw new Error(`Invalid API quota request id for ${providerId}: ${target}`);
        }
        requestIds.add(request.id);
      }
    }

    if (value.leases !== undefined) {
      if (!Array.isArray(value.leases)) {
        throw new Error(`Invalid API quota leases for ${providerId}: ${target}`);
      }
      const leaseIds = new Set<string>();
      for (const [index, lease] of value.leases.entries()) {
        if (!isRecord(lease) || typeof lease.id !== "string" || lease.id.length === 0) {
          throw new Error(`Invalid API quota lease ${providerId}[${index}]: ${target}`);
        }
        if (leaseIds.has(lease.id)) {
          throw new Error(`Duplicate API quota lease ${lease.id}: ${target}`);
        }
        leaseIds.add(lease.id);
        assertFiniteNumber(lease.pid, `${providerId}.leases[${index}].pid`, {
          min: 1,
          integer: true,
        });
        assertFiniteNumber(lease.expiresAt, `${providerId}.leases[${index}].expiresAt`, {
          min: 1,
          integer: true,
        });
      }
    }

    if (!isRecord(value.daily) || typeof value.daily.date !== "string") {
      throw new Error(`Invalid API quota daily state for ${providerId}: ${target}`);
    }
    assertFiniteNumber(value.daily.requests, `${providerId}.daily.requests`, {
      min: 0,
      integer: true,
    });
    assertFiniteNumber(value.daily.tokens, `${providerId}.daily.tokens`, {
      min: 0,
      integer: true,
    });
  }
}

function readQuotaStateStrict(workbench: string): QuotaState {
  const target = quotaPath(workbench);
  if (!existsSync(target)) return { providers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid API quota state JSON: ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateQuotaState(parsed, target);
  return parsed;
}

function quotaLockPath(workbench: string): string {
  return path.join(workbench, "state", "api-quota.lock");
}

function quotaRecoveryGuardPath(workbench: string): string {
  return path.join(workbench, "state", "api-quota.lock.recovery");
}

interface QuotaLockState {
  token: string;
  pid: number;
  acquiredAt: number;
}

const QUOTA_LOCK_STALE_MS = 30_000;
const REQUIRED_QUOTA_LOCK_TIMEOUT_MS = QUOTA_LOCK_STALE_MS + 5_000;

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function syncPause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readQuotaLock(target: string): QuotaLockState | null {
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as Partial<QuotaLockState>;
    if (
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      !Number.isInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      !Number.isFinite(parsed.acquiredAt)
    ) {
      return null;
    }
    return parsed as QuotaLockState;
  } catch {
    return null;
  }
}

function createLockExclusive(target: string, state: QuotaLockState): boolean {
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(target, "wx");
    created = true;
    writeFileSync(fd, JSON.stringify(state), "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    if (created) {
      try {
        unlinkSync(target);
      } catch {
        /* The incomplete lock remains fail-closed. */
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function releaseOwnedLock(target: string, token: string): boolean {
  const lock = readQuotaLock(target);
  if (!lock || lock.token !== token) return false;
  try {
    unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

function acquireRecoveryGuard(workbench: string): string | null {
  const target = quotaRecoveryGuardPath(workbench);
  const create = (): string | null => {
    const token = randomUUID();
    return createLockExclusive(target, {
      token,
      pid: process.pid,
      acquiredAt: Date.now(),
    })
      ? token
      : null;
  };
  const token = create();
  if (token) return token;
  if (!recoverStaleRecoveryGuard(workbench)) return null;
  return create();
}

function recoverStaleRecoveryGuard(workbench: string): boolean {
  const target = quotaRecoveryGuardPath(workbench);
  const observed = readQuotaLock(target);
  let stale = false;
  if (observed) {
    stale =
      !processAlive(observed.pid) &&
      Date.now() - observed.acquiredAt > QUOTA_LOCK_STALE_MS;
  } else {
    try {
      stale = Date.now() - statSync(target).mtimeMs > QUOTA_LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
  if (!stale) return false;

  const current = readQuotaLock(target);
  if (observed ? current?.token !== observed.token : current !== null) return false;

  const quarantine = `${target}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(target, quarantine);
    const moved = readQuotaLock(quarantine);
    if (observed ? moved?.token !== observed.token : moved !== null) {
      if (!existsSync(target)) renameSync(quarantine, target);
      return false;
    }
    rmSync(quarantine, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

function recoverStaleQuotaLock(workbench: string): boolean {
  const guardToken = acquireRecoveryGuard(workbench);
  if (!guardToken) return false;
  const target = quotaLockPath(workbench);
  const guardPath = quotaRecoveryGuardPath(workbench);
  try {
    const observed = readQuotaLock(target);
    let stale = false;
    if (observed) {
      stale =
        !processAlive(observed.pid) && Date.now() - observed.acquiredAt > QUOTA_LOCK_STALE_MS;
    } else {
      try {
        stale = Date.now() - statSync(target).mtimeMs > QUOTA_LOCK_STALE_MS;
      } catch {
        return true;
      }
    }
    if (!stale) return false;

    const current = readQuotaLock(target);
    if (observed) {
      if (!current || current.token !== observed.token) return false;
    } else if (current) {
      return false;
    }
    try {
      unlinkSync(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  } finally {
    if (!releaseOwnedLock(guardPath, guardToken)) {
      throw new Error(`Lost API quota recovery guard ownership: ${guardPath}`);
    }
  }
}

function acquireQuotaLock(workbench: string, timeoutMs = 2_000): string | null {
  mkdirSync(path.join(workbench, "state"), { recursive: true });
  const target = quotaLockPath(workbench);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = randomUUID();
    if (createLockExclusive(target, { token, pid: process.pid, acquiredAt: Date.now() })) {
      if (existsSync(quotaRecoveryGuardPath(workbench))) {
        if (!releaseOwnedLock(target, token)) {
          throw new Error(`Lost API quota lock ownership during recovery: ${target}`);
        }
        recoverStaleRecoveryGuard(workbench);
      } else {
        return token;
      }
    } else {
      recoverStaleQuotaLock(workbench);
    }
    syncPause(20);
  }
  return null;
}

function requireQuotaLock(workbench: string): string {
  const lock = acquireQuotaLock(workbench, REQUIRED_QUOTA_LOCK_TIMEOUT_MS);
  if (!lock) throw new Error(`API quota lock unavailable: ${quotaLockPath(workbench)}`);
  return lock;
}

function releaseQuotaLock(workbench: string, token: string): void {
  const target = quotaLockPath(workbench);
  if (!releaseOwnedLock(target, token)) {
    throw new Error(`Lost API quota lock ownership: ${target}`);
  }
}

export function loadApiLimits(workbench: string): ApiLimitsConfig {
  const p = limitsConfigPath(workbench);
  if (!existsSync(p)) return { providers: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid API limits config JSON: ${p}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateApiLimitsConfig(raw, p);
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
  if (manifest.provider === "openai_codex" || manifest.provider === "cursor_composer") {
    return "openai";
  }
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
  ps.requests = Array.isArray(ps.requests) ? ps.requests : [];
  ps.leases = Array.isArray(ps.leases) ? ps.leases : [];
  ps.inflight = Number.isFinite(ps.inflight) ? ps.inflight : 0;
  ps.lastStartTs = Number.isFinite(ps.lastStartTs) ? ps.lastStartTs : 0;
  ps.backoffUntil = Number.isFinite(ps.backoffUntil) ? ps.backoffUntil : 0;
  ps.backoffStreak = Number.isFinite(ps.backoffStreak) ? ps.backoffStreak : 0;
  if (!ps.daily || typeof ps.daily.date !== "string") {
    ps.daily = { date: todayForQuota(workbench), requests: 0, tokens: 0 };
  }
  const today = todayForQuota(workbench);
  if (ps.daily.date !== today) {
    ps.daily = { date: today, requests: 0, tokens: 0 };
  }
  pruneLeases(ps, Date.now());
  pruneRequests(ps, Date.now());
  return ps;
}

function pruneLeases(ps: ProviderState, now: number): void {
  ps.leases = (ps.leases ?? []).filter(
    (lease) => lease.expiresAt > now && processAlive(lease.pid),
  );
  ps.inflight = ps.leases.length;
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
  opts: { estimatedTokens?: number; leaseMs?: number } = {},
): AcquireResult {
  const lock = acquireQuotaLock(workbench);
  if (!lock) return { ok: false, waitMs: 250, reason: "quota_lock_busy", providerId };
  try {
  const limits = resolveLimits(workbench, providerId);
  const state = readQuotaStateStrict(workbench);
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

  const leaseId = randomUUID();
  ps.leases = ps.leases ?? [];
  ps.leases.push({
    id: leaseId,
    pid: process.pid,
    expiresAt: now + Math.max(60_000, opts.leaseMs ?? 30 * 60_000),
  });
  ps.inflight = ps.leases.length;
  ps.lastStartTs = now;
  ps.requests.push({ id: leaseId, ts: now, tokens: opts.estimatedTokens });
  ps.daily.requests += 1;
  if (opts.estimatedTokens) ps.daily.tokens += opts.estimatedTokens;
  writeQuotaState(workbench, state);
  return { ok: true, providerId, leaseId };
  } finally {
    releaseQuotaLock(workbench, lock);
  }
}

export function releaseApiSlot(
  workbench: string,
  providerId: ApiProviderId,
  leaseId?: string,
): void {
  const lock = requireQuotaLock(workbench);
  try {
  const state = readQuotaStateStrict(workbench);
  const ps = getProviderState(state, workbench, providerId);
  const index = leaseId
    ? (ps.leases ?? []).findIndex((lease) => lease.id === leaseId)
    : (ps.leases ?? []).findIndex((lease) => lease.pid === process.pid);
  if (index < 0) {
    throw new Error(`API quota lease not found for ${providerId}: ${leaseId ?? process.pid}`);
  }
  ps.leases?.splice(index, 1);
  ps.inflight = ps.leases?.length ?? 0;
  writeQuotaState(workbench, state);
  } finally {
    releaseQuotaLock(workbench, lock);
  }
}

export function recordApiSuccess(
  workbench: string,
  providerId: ApiProviderId,
  meta: { tokens?: number; latencyMs?: number; requestId?: string } = {},
): void {
  const lock = requireQuotaLock(workbench);
  try {
  const state = readQuotaStateStrict(workbench);
  const ps = getProviderState(state, workbench, providerId);
  ps.backoffStreak = 0;
  if (ps.backoffUntil <= Date.now()) ps.backoffUntil = 0;
  if (meta.tokens && meta.tokens > 0) {
    const last = meta.requestId
      ? ps.requests.find((request) => request.id === meta.requestId)
      : ps.requests[ps.requests.length - 1];
    if (meta.requestId && !last) {
      throw new Error(`API quota request not found for ${providerId}: ${meta.requestId}`);
    }
    const prevEstimate = last?.tokens ?? 0;
    if (last) last.tokens = meta.tokens;
    ps.daily.tokens = Math.max(0, ps.daily.tokens + meta.tokens - prevEstimate);
  }
  writeQuotaState(workbench, state);
  } finally {
    releaseQuotaLock(workbench, lock);
  }
}

export function recordApiFailure(
  workbench: string,
  providerId: ApiProviderId,
  err: { httpStatus?: number; retryAfterMs?: number; retryable?: boolean; message?: string },
): AcquireResult {
  const lock = requireQuotaLock(workbench);
  try {
  const limits = resolveLimits(workbench, providerId);
  const state = readQuotaStateStrict(workbench);
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
  } finally {
    releaseQuotaLock(workbench, lock);
  }
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForApiSlot(
  workbench: string,
  providerId: ApiProviderId,
  opts: { estimatedTokens?: number; maxWaitMs?: number; leaseMs?: number } = {},
): Promise<AcquireResult> {
  const maxWait = opts.maxWaitMs ?? 600_000;
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    const r = acquireApiSlot(workbench, providerId, {
      estimatedTokens: opts.estimatedTokens,
      leaseMs: opts.leaseMs,
    });
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
  if (kind === "implement" && manifest.phaseId?.includes("ch") && manifest.phaseId.includes("write")) {
    return 35_000;
  }
  if (kind === "review") return 18_000;
  if (kind === "debate") return 22_000;
  return 12_000;
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
  const limits = resolveLimits(workbench, "openai");
  return {
    missionId,
    liveSlots,
    tokensPerSlot,
    totalTokens: liveSlots * tokensPerSlot,
    estimatedWallHours: (liveSlots * 35) / 60,
    providers: {
      openai: {
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
  const lock = requireQuotaLock(workbench);
  try {
    const state = readQuotaStateStrict(workbench);
    const now = Date.now();
    const rows: QuotaStatusRow[] = [];
    for (const providerId of Object.keys(DEFAULT_LIMITS) as ApiProviderId[]) {
      if (!state.providers[providerId] && providerId !== "openai") continue;
      const p = getProviderState(state, workbench, providerId);
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
    writeQuotaState(workbench, state);
    return rows;
  } finally {
    releaseQuotaLock(workbench, lock);
  }
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
