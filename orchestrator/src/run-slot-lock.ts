import { randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveRunDirectory } from "./workbench-paths.js";

interface RunSlotLockState {
  token: string;
  pid: number;
  acquiredAt: number;
}

interface LockSnapshot {
  raw: string;
  state: RunSlotLockState | null;
  kind: "file" | "symlink" | "other";
  dev: bigint;
  ino: bigint;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

export interface RunSlotLease {
  lockPath: string;
  token: string;
  pid: number;
  acquiredAt: number;
}

export interface RunSlotLeaseOptions {
  staleMs?: number;
  maxOwnerAgeMs?: number;
}

const DEFAULT_STALE_MS = 5_000;
const DEFAULT_MAX_OWNER_AGE_MS = 12 * 60 * 60_000;

export function runSlotLockPath(runDir: string): string {
  return path.join(runDir, "slot.lock.json");
}

function recoveryGuardPath(runDir: string): string {
  return path.join(runDir, "slot.lock.recovery.json");
}

export function runLauncherLockPath(workbench: string, runId: string): string {
  resolveRunDirectory(workbench, runId);
  return path.join(workbench, "state", "run-launchers", `${runId}.lock.json`);
}

function launcherRecoveryGuardPath(workbench: string, runId: string): string {
  return `${runLauncherLockPath(workbench, runId)}.recovery`;
}

function parseLockState(raw: string): RunSlotLockState | null {
  try {
    const value = JSON.parse(raw) as Partial<RunSlotLockState>;
    if (
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      !Number.isFinite(value.acquiredAt)
    ) {
      return null;
    }
    return value as RunSlotLockState;
  } catch {
    return null;
  }
}

function readLockSnapshot(target: string): LockSnapshot | null {
  try {
    const stat = lstatSync(target, { bigint: true });
    const kind = stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other";
    const raw = kind === "file" ? readFileSync(target, "utf8") : "";
    return {
      raw,
      state: kind === "file" ? parseLockState(raw) : null,
      kind,
      dev: stat.dev,
      ino: stat.ino,
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeMs),
      birthtimeMs: Number(stat.birthtimeMs),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  const sameIdentity =
    left.kind === right.kind &&
    left.raw === right.raw &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.birthtimeMs === right.birthtimeMs;
  if (!left.state || !right.state) return sameIdentity;
  return (
    sameIdentity &&
    left.state.token === right.state.token &&
    left.state.pid === right.state.pid &&
    left.state.acquiredAt === right.state.acquiredAt
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isStale(snapshot: LockSnapshot, staleMs: number, maxOwnerAgeMs: number): boolean {
  if (snapshot.kind === "other") return false;
  const ageMs = Date.now() - Math.max(snapshot.mtimeMs, snapshot.state?.acquiredAt ?? 0);
  if (ageMs <= staleMs) return false;
  if (ageMs > maxOwnerAgeMs) return true;
  return !snapshot.state || !processAlive(snapshot.state.pid);
}

function createLockExclusive(target: string, state: RunSlotLockState): boolean {
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(target, "wx");
    created = true;
    writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    if (created) {
      try {
        unlinkSync(target);
      } catch {
        // An incomplete lock remains fail-closed when it cannot be removed.
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function restoreQuarantine(quarantine: string, target: string): void {
  try {
    if (!readLockSnapshot(target)) renameSync(quarantine, target);
  } catch {
    // Preserve both paths for manual recovery rather than deleting unknown ownership.
  }
}

function removeSnapshot(target: string, observed: LockSnapshot): boolean {
  const current = readLockSnapshot(target);
  if (!current || !sameSnapshot(observed, current)) return false;
  const quarantine = `${target}.quarantine-${process.pid}-${randomUUID()}`;
  try {
    renameSync(target, quarantine);
    const moved = readLockSnapshot(quarantine);
    if (!moved || !sameSnapshot(observed, moved)) {
      restoreQuarantine(quarantine, target);
      return false;
    }
    unlinkSync(quarantine);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    restoreQuarantine(quarantine, target);
    throw error;
  }
}

function recoverStaleLock(target: string, staleMs: number, maxOwnerAgeMs: number): boolean {
  const observed = readLockSnapshot(target);
  if (!observed) return true;
  if (!isStale(observed, staleMs, maxOwnerAgeMs)) return false;
  return removeSnapshot(target, observed);
}

function acquireRecoveryGuard(
  target: string,
  staleMs: number,
  maxOwnerAgeMs: number,
): RunSlotLease | null {
  const create = (): RunSlotLease | null => {
    const state = { token: randomUUID(), pid: process.pid, acquiredAt: Date.now() };
    return createLockExclusive(target, state) ? { lockPath: target, ...state } : null;
  };
  return create() ?? (recoverStaleLock(target, staleMs, maxOwnerAgeMs) ? create() : null);
}

function acquireLeaseAt(
  target: string,
  guardTarget: string,
  staleMs: number,
  maxOwnerAgeMs: number,
): RunSlotLease | null {
  const create = (): RunSlotLease | null => {
    const state = { token: randomUUID(), pid: process.pid, acquiredAt: Date.now() };
    return createLockExclusive(target, state) ? { lockPath: target, ...state } : null;
  };

  const immediate = create();
  if (immediate) return immediate;

  const guard = acquireRecoveryGuard(guardTarget, staleMs, maxOwnerAgeMs);
  if (!guard) return null;
  let acquired: RunSlotLease | null = null;
  try {
    if (!recoverStaleLock(target, staleMs, maxOwnerAgeMs)) return null;
    acquired = create();
    return acquired;
  } finally {
    if (!releaseRunSlotLease(guard)) {
      if (acquired) releaseRunSlotLease(acquired);
      throw new Error(`Lost run lease recovery guard ownership: ${guard.lockPath}`);
    }
  }
}

export function acquireRunSlotLease(
  runDir: string,
  options: RunSlotLeaseOptions = {},
): RunSlotLease | null {
  const staleMs = Math.max(0, options.staleMs ?? DEFAULT_STALE_MS);
  const maxOwnerAgeMs = Math.max(staleMs + 1, options.maxOwnerAgeMs ?? DEFAULT_MAX_OWNER_AGE_MS);
  return acquireLeaseAt(
    runSlotLockPath(runDir),
    recoveryGuardPath(runDir),
    staleMs,
    maxOwnerAgeMs,
  );
}

export function acquireRunLauncherLease(
  workbench: string,
  runId: string,
  options: RunSlotLeaseOptions = {},
): RunSlotLease | null {
  const staleMs = Math.max(0, options.staleMs ?? DEFAULT_STALE_MS);
  const maxOwnerAgeMs = Math.max(staleMs + 1, options.maxOwnerAgeMs ?? DEFAULT_MAX_OWNER_AGE_MS);
  const target = runLauncherLockPath(workbench, runId);
  mkdirSync(path.dirname(target), { recursive: true });
  return acquireLeaseAt(
    target,
    launcherRecoveryGuardPath(workbench, runId),
    staleMs,
    maxOwnerAgeMs,
  );
}

export function releaseRunSlotLease(lease: RunSlotLease): boolean {
  const observed = readLockSnapshot(lease.lockPath);
  if (!observed?.state || observed.state.token !== lease.token || observed.state.pid !== lease.pid) {
    return false;
  }
  return removeSnapshot(lease.lockPath, observed);
}

export const releaseRunLauncherLease = releaseRunSlotLease;
