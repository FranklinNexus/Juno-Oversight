import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  BOOK_EXPERIMENT_LIMITS,
  DEFAULT_AUTONOMY_LIMITS,
  type AutonomyDecision,
  type AutonomyLimits,
  type AutonomyState,
} from "./autonomy-types.js";
import { todayAutonomyDate } from "./autonomy-day.js";
import { missionComplete, planNextMission, writePlannerSnapshot } from "./mission-planner.js";
import { recordEvolutionTick, loadEvolutionConfig } from "./evolution-unit.js";

export type { AutonomyDecision, AutonomyLimits, AutonomyState } from "./autonomy-types.js";
export { DEFAULT_AUTONOMY_LIMITS, BOOK_EXPERIMENT_LIMITS } from "./autonomy-types.js";

function statePath(workbench: string): string {
  return path.join(workbench, "state", "bounded-autonomy.json");
}

function stateLockPath(workbench: string): string {
  return path.join(workbench, "state", "bounded-autonomy.lock.json");
}

const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_MAX_AGE_MS = 5 * 60_000;
const RESERVATION_MAX_AGE_MS = 12 * 60 * 60_000;

export type AutonomyReservationOutcome = "reserved" | "succeeded" | "failed" | "interrupted";

export interface AutonomyReservation {
  actionId: string;
  action: AutonomyDecision["action"];
  missionId?: string;
  ownerPid: number;
  reservedAt: string;
  outcome: AutonomyReservationOutcome;
  settledAt?: string;
  detail?: string;
}

interface PersistedAutonomyState extends AutonomyState {
  activeReservation?: AutonomyReservation;
  lastReservation?: AutonomyReservation;
}

interface StateLock {
  path: string;
  token: string;
  pid: number;
  acquiredAt: number;
}

interface StateLockSnapshot {
  raw: string;
  state: StateLock | null;
  kind: "file" | "symlink" | "other";
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readStateLockSnapshot(target: string): StateLockSnapshot | null {
  try {
    const stat = lstatSync(target);
    const kind = stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other";
    const raw = kind === "file" ? readFileSync(target, "utf8") : "";
    let state: StateLock | null = null;
    if (kind === "file") {
      try {
        const value = JSON.parse(raw) as Partial<StateLock>;
        if (
          typeof value.token === "string" &&
          Number.isSafeInteger(value.pid) &&
          (value.pid ?? 0) > 0 &&
          Number.isFinite(value.acquiredAt)
        ) {
          state = { path: target, ...value } as StateLock;
        }
      } catch {
        state = null;
      }
    }
    return {
      raw,
      state,
      kind,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameStateLockSnapshot(left: StateLockSnapshot, right: StateLockSnapshot): boolean {
  return (
    left.raw === right.raw &&
    left.kind === right.kind &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function removeOwnedStateLock(lock: StateLock): boolean {
  const current = readStateLockSnapshot(lock.path);
  if (
    !current?.state ||
    current.state.token !== lock.token ||
    current.state.pid !== lock.pid
  ) return false;
  const quarantine = `${lock.path}.released-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lock.path, quarantine);
    const moved = readStateLockSnapshot(quarantine);
    if (!moved || !sameStateLockSnapshot(current, moved)) {
      if (!existsSync(lock.path)) renameSync(quarantine, lock.path);
      return false;
    }
    rmSync(quarantine, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function createStateLock(target: string): StateLock | null {
  const lock: StateLock = {
    path: target,
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: Date.now(),
  };
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(target, "wx");
    created = true;
    writeFileSync(
      descriptor,
      `${JSON.stringify({ token: lock.token, pid: lock.pid, acquiredAt: lock.acquiredAt })}\n`,
      "utf8",
    );
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    if (created) rmSync(target, { force: true });
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function acquireStateLock(workbench: string): StateLock {
  const target = stateLockPath(workbench);
  mkdirSync(path.dirname(target), { recursive: true });
  const immediate = createStateLock(target);
  if (immediate) return immediate;

  let stale = false;
  const observed = readStateLockSnapshot(target);
  if (!observed) {
    stale = true;
  } else if (observed.state) {
    const age = Date.now() - observed.state.acquiredAt;
    stale =
      age > STATE_LOCK_MAX_AGE_MS ||
      (age > STATE_LOCK_STALE_MS && !processIsAlive(observed.state.pid));
  } else {
    stale = Date.now() - observed.mtimeMs > STATE_LOCK_STALE_MS;
  }
  if (!stale) throw new Error(`Autonomy state mutation is busy: ${target}`);

  const quarantine = `${target}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(target, quarantine);
    const moved = readStateLockSnapshot(quarantine);
    if (observed && (!moved || !sameStateLockSnapshot(observed, moved))) {
      if (!existsSync(target)) renameSync(quarantine, target);
      throw new Error(`Autonomy state lock changed during stale recovery: ${target}`);
    }
    rmSync(quarantine, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const recovered = createStateLock(target);
  if (!recovered) throw new Error(`Autonomy state mutation is busy after recovery: ${target}`);
  return recovered;
}

function withStateLock<T>(workbench: string, operation: () => T): T {
  const lock = acquireStateLock(workbench);
  let result!: T;
  let failure: unknown;
  try {
    result = operation();
  } catch (error) {
    failure = error;
  }
  let releaseFailure: unknown;
  try {
    if (!removeOwnedStateLock(lock)) {
      releaseFailure = new Error(`Lost autonomy state lock ownership: ${lock.path}`);
    }
  } catch (error) {
    releaseFailure = error;
  }
  if (failure && releaseFailure) {
    throw new AggregateError([failure, releaseFailure], "Autonomy state mutation and lock release failed");
  }
  if (failure) throw failure;
  if (releaseFailure) throw releaseFailure;
  return result;
}

function atomicWriteAutonomyState(workbench: string, state: PersistedAutonomyState): void {
  const target = statePath(workbench);
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

function todayForWorkbench(workbench: string): string {
  return todayAutonomyDate(workbench);
}

const AUTONOMY_ACTIONS = new Set<AutonomyDecision["action"]>([
  "run_local_loop",
  "run_agi_loop",
  "run_book_loop",
  "run_book_quality_loop",
  "run_generic_loop",
  "run_self_optimize",
  "queue_mission",
  "stop",
  "escalate_human",
]);

function validateReservation(
  value: unknown,
  label: string,
  expectedOutcome?: AutonomyReservationOutcome,
): AutonomyReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const reservation = value as Partial<AutonomyReservation>;
  if (
    typeof reservation.actionId !== "string" ||
    reservation.actionId.length < 16 ||
    typeof reservation.action !== "string" ||
    !AUTONOMY_ACTIONS.has(reservation.action as AutonomyDecision["action"]) ||
    !Number.isSafeInteger(reservation.ownerPid) ||
    (reservation.ownerPid ?? 0) <= 0 ||
    typeof reservation.reservedAt !== "string" ||
    !Number.isFinite(Date.parse(reservation.reservedAt)) ||
    !["reserved", "succeeded", "failed", "interrupted"].includes(
      reservation.outcome as string,
    ) ||
    (expectedOutcome !== undefined && reservation.outcome !== expectedOutcome) ||
    (reservation.missionId !== undefined && typeof reservation.missionId !== "string") ||
    (reservation.settledAt !== undefined &&
      (typeof reservation.settledAt !== "string" ||
        !Number.isFinite(Date.parse(reservation.settledAt)))) ||
    (reservation.detail !== undefined && typeof reservation.detail !== "string")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return reservation as AutonomyReservation;
}

function validatePersistedState(value: unknown, target: string): PersistedAutonomyState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Autonomy state is invalid: ${target}`);
  }
  const raw = value as Partial<PersistedAutonomyState>;
  if (
    typeof raw.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raw.date) ||
    !Number.isSafeInteger(raw.iterationsToday) ||
    (raw.iterationsToday ?? -1) < 0 ||
    !Number.isSafeInteger(raw.autoQueuedToday) ||
    (raw.autoQueuedToday ?? -1) < 0 ||
    (raw.lastAction !== undefined && typeof raw.lastAction !== "string") ||
    (raw.lastDecisionAt !== undefined &&
      (typeof raw.lastDecisionAt !== "string" || !Number.isFinite(Date.parse(raw.lastDecisionAt)))) ||
    (raw.lastMissionId !== undefined && typeof raw.lastMissionId !== "string")
  ) {
    throw new Error(`Autonomy state is invalid: ${target}`);
  }
  if (raw.activeReservation !== undefined) {
    validateReservation(raw.activeReservation, "active autonomy reservation", "reserved");
  }
  if (raw.lastReservation !== undefined) {
    const last = validateReservation(raw.lastReservation, "last autonomy reservation");
    if (last.outcome === "reserved") throw new Error("last autonomy reservation is unsettled");
  }
  return raw as PersistedAutonomyState;
}

function readPersistedAutonomyState(workbench: string): PersistedAutonomyState {
  const p = statePath(workbench);
  const today = todayForWorkbench(workbench);
  if (!existsSync(p)) {
    return { date: today, iterationsToday: 0, autoQueuedToday: 0 };
  }
  let raw: PersistedAutonomyState;
  try {
    raw = validatePersistedState(JSON.parse(readFileSync(p, "utf8")), p);
  } catch (error) {
    throw new Error(`Autonomy state is unreadable; refusing to reset daily limits: ${p}`, {
      cause: error,
    });
  }
  if (raw.date > today) {
    throw new Error(`Autonomy state date is in the future (${raw.date}); refusing to reset limits`);
  }
  return raw;
}

export function readAutonomyState(workbench: string): AutonomyState {
  const raw = readPersistedAutonomyState(workbench);
  const today = todayForWorkbench(workbench);
  if (raw.date !== today) {
    return {
      date: today,
      iterationsToday: 0,
      autoQueuedToday: 0,
      ...(raw.activeReservation ? { activeReservation: raw.activeReservation } : {}),
    } as AutonomyState;
  }
  return raw;
}

export function writeAutonomyState(workbench: string, state: AutonomyState): void {
  const validated = validatePersistedState(state, statePath(workbench));
  withStateLock(workbench, () => atomicWriteAutonomyState(workbench, validated));
}

function missionStarted(workbench: string, missionId: string): boolean {
  return existsSync(path.join(workbench, "missions", missionId, "progress.md"));
}

function limitsForWorkbench(workbench: string, base: AutonomyLimits): AutonomyLimits {
  if (
    missionStarted(workbench, "juno-axiom-book-2026") &&
    !missionComplete(workbench, "juno-axiom-book-2026")
  ) return BOOK_EXPERIMENT_LIMITS;
  return base;
}

/**
 * Bounded self-decision: charter + mission registry → next action without human-assigned mission.
 */
export function decideNextAction(
  workbench: string,
  limits: AutonomyLimits = DEFAULT_AUTONOMY_LIMITS,
): AutonomyDecision {
  const effective = limitsForWorkbench(workbench, limits);
  const state = readAutonomyState(workbench);
  const decision = planNextMission({ workbench, state, limits: effective });
  writePlannerSnapshot(workbench, decision);
  return decision;
}

function countsAsIteration(decision: AutonomyDecision): boolean {
  return (
    decision.action === "run_local_loop" ||
    decision.action === "run_agi_loop" ||
    decision.action === "run_book_loop" ||
    decision.action === "run_book_quality_loop" ||
    decision.action === "run_generic_loop" ||
    decision.action === "run_self_optimize" ||
    decision.action === "queue_mission"
  );
}

function missionIdForDecision(decision: AutonomyDecision): string | undefined {
  return "missionId" in decision ? decision.missionId : undefined;
}

function recordEvolutionOutcome(
  workbench: string,
  decision: AutonomyDecision,
): void {
  try {
    if (loadEvolutionConfig(workbench).enabled === false) return;
    // self-optimize records its own evolution entry (avoids double log)
    if (decision.action === "run_self_optimize") return;
    const idlePenaltyCount = decision.action === "stop" ? 1 : 0;
    recordEvolutionTick(workbench, {
      trigger: "autonomy_tick",
      action: decision.action,
      missionId: missionIdForDecision(decision),
      idlePenaltyCount,
      note: "reason" in decision ? decision.reason.slice(0, 120) : undefined,
    });
  } catch {
    /* fitness is best-effort */
  }
}

function settleInterruptedReservation(
  state: PersistedAutonomyState,
  now: string,
): boolean {
  const active = state.activeReservation;
  if (!active) return false;
  const ageMs = Date.parse(now) - Date.parse(active.reservedAt);
  if (ageMs < 0) {
    throw new Error(`Autonomy reservation ${active.actionId} is future-dated`);
  }
  if (processIsAlive(active.ownerPid) && ageMs <= RESERVATION_MAX_AGE_MS) {
    const error = new Error(
      `Autonomy action is already reserved: ${active.actionId} pid=${active.ownerPid}`,
    );
    (error as NodeJS.ErrnoException).code = "AUTONOMY_ACTION_ACTIVE";
    throw error;
  }
  state.lastReservation = {
    ...active,
    outcome: "interrupted",
    settledAt: now,
    detail: "owner exited or reservation exceeded the absolute owner age",
  };
  delete state.activeReservation;
  return true;
}

function resetStateForToday(
  state: PersistedAutonomyState,
  today: string,
): PersistedAutonomyState {
  if (state.date === today) return state;
  if (state.activeReservation) {
    throw new Error(`Cannot reset autonomy day while action ${state.activeReservation.actionId} is active`);
  }
  return {
    date: today,
    iterationsToday: 0,
    autoQueuedToday: 0,
    lastReservation: state.lastReservation,
  };
}

function autonomyCapError(detail: string): Error {
  const error = new Error(detail);
  (error as NodeJS.ErrnoException).code = "AUTONOMY_CAP_REACHED";
  return error;
}

export function reserveAutonomyDecision(
  workbench: string,
  decision: AutonomyDecision,
  limits: AutonomyLimits = DEFAULT_AUTONOMY_LIMITS,
): { actionId: string; state: AutonomyState } {
  return withStateLock(workbench, () => {
    const now = new Date().toISOString();
    const today = todayForWorkbench(workbench);
    let state = readPersistedAutonomyState(workbench);
    const reconciled = settleInterruptedReservation(state, now);
    state = resetStateForToday(state, today);

    const effective = limitsForWorkbench(workbench, limits);
    const consumesIteration = countsAsIteration(decision);
    const missionId = missionIdForDecision(decision);
    const restoresMission =
      decision.action === "queue_mission" && Boolean(missionId && missionStarted(workbench, missionId));
    if (consumesIteration && state.iterationsToday >= effective.maxSelfIterationsPerDay) {
      if (reconciled) atomicWriteAutonomyState(workbench, state);
      throw autonomyCapError(
        `Daily autonomy iteration cap reached (${state.iterationsToday}/${effective.maxSelfIterationsPerDay})`,
      );
    }
    if (
      decision.action === "queue_mission" &&
      !restoresMission &&
      state.autoQueuedToday >= effective.maxAutoQueueMissions
    ) {
      if (reconciled) atomicWriteAutonomyState(workbench, state);
      throw autonomyCapError(
        `Daily auto-queue cap reached (${state.autoQueuedToday}/${effective.maxAutoQueueMissions})`,
      );
    }

    const actionId = randomUUID();
    if (consumesIteration) state.iterationsToday += 1;
    if (decision.action === "queue_mission" && !restoresMission) state.autoQueuedToday += 1;
    state.activeReservation = {
      actionId,
      action: decision.action,
      missionId,
      ownerPid: process.pid,
      reservedAt: now,
      outcome: "reserved",
    };
    state.lastAction = decision.action;
    state.lastDecisionAt = now;
    if (missionId) state.lastMissionId = missionId;
    atomicWriteAutonomyState(workbench, state);
    return { actionId, state };
  });
}

export function settleAutonomyDecision(
  workbench: string,
  actionId: string,
  decision: AutonomyDecision,
  opts: { succeeded: boolean; detail?: string },
): AutonomyState {
  const settlement = withStateLock(workbench, () => {
    const state = readPersistedAutonomyState(workbench);
    if (!state.activeReservation) {
      if (state.lastReservation?.actionId === actionId) {
        return { state, alreadySettled: true };
      }
      throw new Error(`No active autonomy reservation for action ${actionId}`);
    }
    if (state.activeReservation.actionId !== actionId) {
      throw new Error(
        `Autonomy reservation mismatch: expected ${state.activeReservation.actionId}, got ${actionId}`,
      );
    }
    if (state.activeReservation.action !== decision.action) {
      throw new Error(
        `Autonomy reservation action changed: ${state.activeReservation.action} != ${decision.action}`,
      );
    }
    const now = new Date().toISOString();
    state.lastReservation = {
      ...state.activeReservation,
      outcome: opts.succeeded ? "succeeded" : "failed",
      settledAt: now,
      detail: opts.detail?.slice(0, 500),
    };
    delete state.activeReservation;
    state.lastAction = decision.action;
    state.lastDecisionAt = now;
    const missionId = missionIdForDecision(decision);
    if (missionId) state.lastMissionId = missionId;
    atomicWriteAutonomyState(workbench, state);
    return { state, alreadySettled: false };
  });
  if (!settlement.alreadySettled) recordEvolutionOutcome(workbench, decision);
  return settlement.state;
}

export function recordAutonomyDecision(
  workbench: string,
  decision: AutonomyDecision,
  opts: { succeeded?: boolean } = {},
): AutonomyState {
  const succeeded = opts.succeeded !== false;
  const state = withStateLock(workbench, () => {
    const now = new Date().toISOString();
    let current = readPersistedAutonomyState(workbench);
    const reconciled = settleInterruptedReservation(current, now);
    current = resetStateForToday(current, todayForWorkbench(workbench));
    const effective = limitsForWorkbench(workbench, DEFAULT_AUTONOMY_LIMITS);
    const consumesIteration = succeeded && countsAsIteration(decision);
    const missionId = missionIdForDecision(decision);
    const restoresMission =
      decision.action === "queue_mission" && Boolean(missionId && missionStarted(workbench, missionId));
    if (consumesIteration && current.iterationsToday >= effective.maxSelfIterationsPerDay) {
      if (reconciled) atomicWriteAutonomyState(workbench, current);
      throw autonomyCapError(
        `Daily autonomy iteration cap reached (${current.iterationsToday}/${effective.maxSelfIterationsPerDay})`,
      );
    }
    if (
      succeeded &&
      decision.action === "queue_mission" &&
      !restoresMission &&
      current.autoQueuedToday >= effective.maxAutoQueueMissions
    ) {
      if (reconciled) atomicWriteAutonomyState(workbench, current);
      throw autonomyCapError(
        `Daily auto-queue cap reached (${current.autoQueuedToday}/${effective.maxAutoQueueMissions})`,
      );
    }
    current.lastAction = decision.action;
    current.lastDecisionAt = now;
    if (missionId) current.lastMissionId = missionId;
    if (consumesIteration) current.iterationsToday += 1;
    if (succeeded && decision.action === "queue_mission" && !restoresMission) {
      current.autoQueuedToday += 1;
    }
    atomicWriteAutonomyState(workbench, current);
    return current;
  });
  recordEvolutionOutcome(workbench, decision);
  return state;
}
