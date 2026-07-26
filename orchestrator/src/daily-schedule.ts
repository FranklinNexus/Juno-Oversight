/**
 * Daily schedule config — loaded from AgentWorkbench/config/daily-schedule.json
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PurgePolicy } from "./workbench-purge.js";

export interface DailyScheduleConfig {
  enabled?: boolean;
  /** IANA timezone for autonomy day boundary (default Asia/Shanghai). */
  autonomyTimezone?: string;
  /** Local hour 0–23 to start (Task Scheduler should match). */
  startHourLocal?: number;
  /** Tick interval while filling daily cap (ms). */
  tickIntervalMs?: number;
  /** Override maxSelfIterationsPerDay; null = use autonomy defaults. */
  maxIterationsPerDay?: number | null;
  /** Stop after N consecutive planner `stop`/no-progress decisions. */
  maxIdleTicks?: number | null;
  /** Isolated export root — NEVER Vault / repo / Workbench. */
  exportRoot?: string;
  /** Copy mission markdown + state snapshots for Obsidian reading. */
  exportObsidianBundle?: boolean;
  /** Mission ids to include in export (empty = all with progress.md). */
  exportMissionIds?: string[];
  /** Run aggressive purge after export. */
  purgeAfterRun?: boolean;
  /** Purge policy when purgeAfterRun is true. */
  purgePolicy?: Partial<PurgePolicy>;
  /** Keep last N days of export folders (delete older). */
  exportRetentionDays?: number;
}

export const DEFAULT_DAILY_SCHEDULE: DailyScheduleConfig = {
  enabled: true,
  autonomyTimezone: "Asia/Shanghai",
  startHourLocal: 0,
  tickIntervalMs: 120_000,
  maxIterationsPerDay: null,
  maxIdleTicks: 5,
  exportRoot: "E:\\JunoDailyExport",
  exportObsidianBundle: true,
  exportMissionIds: [],
  purgeAfterRun: true,
  purgePolicy: {
    runsRetentionDays: 0,
    runsKeepRecent: 3,
    stagingRetentionDays: 0,
    purgeEmptyRuns: true,
  },
  exportRetentionDays: 30,
};

export function dailySchedulePath(workbench: string): string {
  return path.join(workbench, "config", "daily-schedule.json");
}

export function loadDailySchedule(workbench: string): DailyScheduleConfig {
  const p = dailySchedulePath(workbench);
  if (!existsSync(p)) {
    return { ...DEFAULT_DAILY_SCHEDULE };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (error) {
    throw new Error(`Daily schedule is unreadable; refusing scheduled autonomy: ${p}`, {
      cause: error,
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Daily schedule must be a JSON object: ${p}`);
  }
  const config = raw as DailyScheduleConfig;
  const positiveIntegerOrNull = (value: unknown): boolean =>
    value === undefined ||
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  if (
    (config.enabled !== undefined && typeof config.enabled !== "boolean") ||
    (config.autonomyTimezone !== undefined && typeof config.autonomyTimezone !== "string") ||
    (config.startHourLocal !== undefined &&
      (!Number.isSafeInteger(config.startHourLocal) || config.startHourLocal < 0 || config.startHourLocal > 23)) ||
    (config.tickIntervalMs !== undefined &&
      (!Number.isSafeInteger(config.tickIntervalMs) || config.tickIntervalMs < 1_000)) ||
    !positiveIntegerOrNull(config.maxIterationsPerDay) ||
    !positiveIntegerOrNull(config.maxIdleTicks) ||
    (config.exportRoot !== undefined &&
      (typeof config.exportRoot !== "string" || !config.exportRoot.trim())) ||
    (config.exportMissionIds !== undefined &&
      (!Array.isArray(config.exportMissionIds) ||
        config.exportMissionIds.some((id) => typeof id !== "string" || !id.trim())))
  ) {
    throw new Error(`Daily schedule contains invalid control fields: ${p}`);
  }
  if (config.autonomyTimezone) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: config.autonomyTimezone }).format();
    } catch (error) {
      throw new Error(`Daily schedule has invalid autonomyTimezone: ${config.autonomyTimezone}`, {
        cause: error,
      });
    }
  }
  return { ...DEFAULT_DAILY_SCHEDULE, ...config };
}
