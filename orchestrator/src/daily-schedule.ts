/**
 * Daily schedule config — loaded from AgentWorkbench/config/daily-schedule.json
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PurgePolicy } from "./workbench-purge.js";

export interface DailyScheduleConfig {
  enabled?: boolean;
  /** Local hour 0–23 to start (Task Scheduler should match). */
  startHourLocal?: number;
  /** Tick interval while filling daily cap (ms). */
  tickIntervalMs?: number;
  /** Override maxSelfIterationsPerDay; null = use autonomy defaults. */
  maxIterationsPerDay?: number | null;
  /** Stop after N consecutive planner `stop` decisions (no work). */
  maxIdleTicks?: number;
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
  startHourLocal: 7,
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
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as DailyScheduleConfig;
    return { ...DEFAULT_DAILY_SCHEDULE, ...raw };
  } catch {
    return { ...DEFAULT_DAILY_SCHEDULE };
  }
}
