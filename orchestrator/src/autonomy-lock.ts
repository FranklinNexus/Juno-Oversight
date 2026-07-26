/**
 * Global mutex for juno:daemon vs daily:juno — one autonomy driver at a time.
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

export type AutonomyLockHolder =
  | "juno-daemon"
  | "scheduler-daemon"
  | "daily-juno"
  | "autonomy-tick";

export interface AutonomyLockState {
  pid: number;
  holder: AutonomyLockHolder;
  since: string;
}

function lockPath(workbench: string): string {
  return path.join(workbench, "state", "autonomy.lock.json");
}

function recoveryGuardPath(workbench: string): string {
  return path.join(workbench, "state", "autonomy.lock.recovery");
}

interface RecoveryGuardState {
  token: string;
  pid: number;
  acquiredAt: number;
}

const RECOVERY_GUARD_STALE_MS = 30_000;

function readRecoveryGuard(target: string): RecoveryGuardState | null {
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as Partial<RecoveryGuardState>;
    if (
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      !Number.isFinite(parsed.acquiredAt)
    ) {
      return null;
    }
    return parsed as RecoveryGuardState;
  } catch {
    return null;
  }
}

function createRecoveryGuard(target: string, state: RecoveryGuardState): boolean {
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(target, "wx");
    created = true;
    writeFileSync(fd, JSON.stringify(state), "utf8");
    return true;
  } catch {
    if (created) {
      try {
        unlinkSync(target);
      } catch {
        /* A partial guard remains fail-closed until its stale timeout. */
      }
    }
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function reclaimStaleRecoveryGuard(workbench: string): boolean {
  const target = recoveryGuardPath(workbench);
  const observed = readRecoveryGuard(target);
  let stale = false;
  if (observed) {
    stale =
      !isProcessAlive(observed.pid) &&
      Date.now() - observed.acquiredAt > RECOVERY_GUARD_STALE_MS;
  } else {
    try {
      stale = Date.now() - statSync(target).mtimeMs > RECOVERY_GUARD_STALE_MS;
    } catch {
      return true;
    }
  }
  if (!stale) return false;

  const current = readRecoveryGuard(target);
  if (observed ? current?.token !== observed.token : current !== null) return false;

  const quarantine = `${target}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(target, quarantine);
    const moved = readRecoveryGuard(quarantine);
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

function acquireRecoveryGuard(workbench: string): string | null {
  const target = recoveryGuardPath(workbench);
  const create = (): string | null => {
    const token = randomUUID();
    return createRecoveryGuard(target, {
      token,
      pid: process.pid,
      acquiredAt: Date.now(),
    })
      ? token
      : null;
  };
  const token = create();
  if (token) return token;
  if (!reclaimStaleRecoveryGuard(workbench)) return null;
  return create();
}

function releaseRecoveryGuard(workbench: string, token: string): void {
  const target = recoveryGuardPath(workbench);
  if (readRecoveryGuard(target)?.token !== token) return;
  try {
    unlinkSync(target);
  } catch {
    /* A residual guard intentionally blocks future lock mutation. */
  }
}

function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const INCOMPLETE_LOCK_GRACE_MS = 5_000;

function createLockExclusive(
  workbench: string,
  holder: AutonomyLockHolder,
  pid: number,
): boolean {
  const p = lockPath(workbench);
  let fd: number | undefined;
  try {
    fd = openSync(p, "wx");
    writeFileSync(
      fd,
      `${JSON.stringify({ pid, holder, since: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readAutonomyLock(workbench: string): AutonomyLockState | null {
  const p = lockPath(workbench);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AutonomyLockState;
  } catch {
    return null;
  }
}

/** Returns false if another live holder owns the lock. */
export function acquireAutonomyLock(
  workbench: string,
  holder: AutonomyLockHolder,
  pid: number = process.pid,
): boolean {
  mkdirSync(path.join(workbench, "state"), { recursive: true });
  const guardToken = acquireRecoveryGuard(workbench);
  if (!guardToken) return false;
  try {
    if (!existsSync(lockPath(workbench))) {
      return createLockExclusive(workbench, holder, pid);
    }

    const existing = readAutonomyLock(workbench);
    if (existing) {
      if (existing.pid === pid && existing.holder === holder) return true;
      if (isProcessAlive(existing.pid)) return false;
    } else {
      try {
        if (Date.now() - statSync(lockPath(workbench)).mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
          return false;
        }
      } catch {
        return createLockExclusive(workbench, holder, pid);
      }
    }

    try {
      unlinkSync(lockPath(workbench));
    } catch {
      return false;
    }
    return createLockExclusive(workbench, holder, pid);
  } finally {
    releaseRecoveryGuard(workbench, guardToken);
  }
}

export function releaseAutonomyLock(
  workbench: string,
  holder: AutonomyLockHolder,
  pid: number = process.pid,
): void {
  const guardToken = acquireRecoveryGuard(workbench);
  if (!guardToken) return;
  try {
    const existing = readAutonomyLock(workbench);
    if (!existing || existing.pid !== pid || existing.holder !== holder) return;
    try {
      unlinkSync(lockPath(workbench));
    } catch {
      /* ignore */
    }
  } finally {
    releaseRecoveryGuard(workbench, guardToken);
  }
}
