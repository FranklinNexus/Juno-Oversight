/**
 * Autonomy "day" boundary — local timezone, not UTC midnight.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_TIMEZONE = "Asia/Shanghai";

export function autonomyTimezonePath(workbench: string): string {
  return path.join(workbench, "config", "daily-schedule.json");
}

export function loadAutonomyTimezone(workbench: string): string {
  const p = autonomyTimezonePath(workbench);
  if (!existsSync(p)) return DEFAULT_TIMEZONE;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { autonomyTimezone?: string };
    return raw.autonomyTimezone?.trim() || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** YYYY-MM-DD in the configured local timezone (for daily iteration caps). */
export function todayAutonomyDate(workbench: string, timezone?: string): string {
  const tz = timezone ?? loadAutonomyTimezone(workbench);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
