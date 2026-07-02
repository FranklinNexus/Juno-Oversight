/**
 * Global mutex for juno:daemon vs daily:juno — one autonomy driver at a time.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type AutonomyLockHolder = "juno-daemon" | "daily-juno" | "autonomy-tick";

export interface AutonomyLockState {
  pid: number;
  holder: AutonomyLockHolder;
  since: string;
}

function lockPath(workbench: string): string {
  return path.join(workbench, "state", "autonomy.lock.json");
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
  const existing = readAutonomyLock(workbench);
  if (existing && existing.pid !== pid && isProcessAlive(existing.pid)) {
    return false;
  }
  writeFileSync(
    lockPath(workbench),
    `${JSON.stringify({ pid, holder, since: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  return true;
}

export function releaseAutonomyLock(workbench: string, pid: number = process.pid): void {
  const existing = readAutonomyLock(workbench);
  if (!existing || existing.pid !== pid) return;
  try {
    unlinkSync(lockPath(workbench));
  } catch {
    /* ignore */
  }
}
