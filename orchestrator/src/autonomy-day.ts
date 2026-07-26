/**
 * Autonomy "day" boundary — local timezone, not UTC midnight.
 */
import path from "node:path";
import { loadDailySchedule } from "./daily-schedule.js";

const DEFAULT_TIMEZONE = "Asia/Shanghai";

export function autonomyTimezonePath(workbench: string): string {
  return path.join(workbench, "config", "daily-schedule.json");
}

export function loadAutonomyTimezone(workbench: string): string {
  return loadDailySchedule(workbench).autonomyTimezone?.trim() || DEFAULT_TIMEZONE;
}

/** YYYY-MM-DD at a specific instant in the configured local timezone. */
export function autonomyDateAtMs(ms: number, timezone: string): string {
  if (!Number.isFinite(ms)) throw new Error(`Invalid autonomy timestamp: ${ms}`);
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(ms));
}

/** YYYY-MM-DD in the configured local timezone (for daily iteration caps). */
export function todayAutonomyDate(workbench: string, timezone?: string): string {
  const tz = timezone ?? loadAutonomyTimezone(workbench);
  return autonomyDateAtMs(Date.now(), tz);
}

/** Milliseconds until the next autonomy day boundary (local midnight in configured TZ). */
export function msUntilNextAutonomyDay(
  workbench: string,
  nowMs: number = Date.now(),
): number {
  const tz = loadAutonomyTimezone(workbench);
  const today = autonomyDateAtMs(nowMs, tz);
  let cursor = nowMs + 30_000;
  const maxProbe = nowMs + 49 * 3_600_000;
  while (cursor < maxProbe && autonomyDateAtMs(cursor, tz) === today) {
    cursor += 60_000;
  }
  if (cursor >= maxProbe) return 3_600_000;
  cursor -= 60_000;
  while (cursor < maxProbe && autonomyDateAtMs(cursor, tz) === today) {
    cursor += 1_000;
  }
  return Math.max(1_000, cursor - nowMs);
}
