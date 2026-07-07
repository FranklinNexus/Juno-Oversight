#!/usr/bin/env node
/**
 * Daily Juno batch — fill autonomy cap, export to isolated folder, purge ephemeral runs.
 *
 * Usage:
 *   node scripts/run-daily-juno.mjs              # run now (one-shot)
 *   node scripts/run-daily-juno.mjs --dry-run    # validate export/purge plan only
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const dryRun = process.argv.includes("--dry-run");

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

function log(msg) {
  process.stderr.write(`[daily-juno] ${msg}\n`);
}

function buildOrchestrator() {
  const r = spawnSync("pnpm", ["orchestrator:build"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

buildOrchestrator();

const { loadProjectEnv } = await import("../orchestrator/dist/env.js");
loadProjectEnv();

const { loadDailySchedule } = await import("../orchestrator/dist/daily-schedule.js");
const { readAutonomyState, DEFAULT_AUTONOMY_LIMITS } = await import(
  "../orchestrator/dist/bounded-autonomy.js"
);
const { syncBookQualityMissionComplete } = await import("../orchestrator/dist/self-optimize.js");
const { runDailyExport, validateExportRoot } = await import(
  "../orchestrator/dist/daily-export.js"
);
const { planWorkbenchPurge, executeWorkbenchPurge } = await import(
  "../orchestrator/dist/workbench-purge.js"
);
const { acquireAutonomyLock, releaseAutonomyLock, readAutonomyLock } = await import(
  "../orchestrator/dist/autonomy-lock.js"
);
const { todayAutonomyDate } = await import("../orchestrator/dist/autonomy-day.js");

const schedule = loadDailySchedule(workbench);
if (syncBookQualityMissionComplete(workbench)) {
  log("book-quality mission marked COMPLETE (scan PASS)");
}
const stateDir = path.join(workbench, "state");
const runStatePath = path.join(stateDir, "daily-juno.json");
const pidPath = path.join(stateDir, "daily-juno.pid");

mkdirSync(stateDir, { recursive: true });

const runReport = {
  startedAt: new Date().toISOString(),
  autonomyDate: todayAutonomyDate(workbench),
  dryRun,
  schedule: {
    exportRoot: schedule.exportRoot,
    maxIterationsPerDay: schedule.maxIterationsPerDay,
    autonomyTimezone: schedule.autonomyTimezone,
  },
  ticks: 0,
  capFilled: false,
  idleStreak: 0,
  export: null,
  purge: null,
  validation: null,
};

if (dryRun) {
  const vaultCfg = existsSync(path.join(workbench, "config.yaml"))
    ? readFileSync(path.join(workbench, "config.yaml"), "utf8").match(/vault_path:\s*["']?([^"'\n]+)/i)?.[1]
    : undefined;
  const exportCheck = validateExportRoot(schedule.exportRoot ?? "E:\\JunoDailyExport", {
    workbenchRoot: workbench,
    repoRoot,
    vaultPath: vaultCfg?.trim().replace(/\\\\/g, "\\"),
  });
  const purgePolicy = {
    runsRetentionDays: 0,
    runsKeepRecent: 3,
    stagingRetentionDays: 0,
    purgeEmptyRuns: true,
    ...schedule.purgePolicy,
  };
  const purgePlan = planWorkbenchPurge(workbench, purgePolicy);
  runReport.validation = {
    exportOk: exportCheck.ok,
    exportReason: exportCheck.ok ? undefined : exportCheck.reason,
    purgeCandidates: purgePlan.candidates.length,
    purgeBytes: purgePlan.totalBytes,
  };
  writeFileSync(runStatePath, `${JSON.stringify({ ...runReport, status: "dry-run" }, null, 2)}\n`, "utf8");
  log(JSON.stringify(runReport.validation, null, 2));
  process.exit(exportCheck.ok ? 0 : 1);
}

if (existsSync(pidPath)) {
  const oldPid = Number(readFileSync(pidPath, "utf8").trim());
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, 0);
      log(`already running pid=${oldPid}`);
      process.exit(1);
    } catch {
      /* stale */
    }
  }
}
writeFileSync(pidPath, String(process.pid), "utf8");

if (!acquireAutonomyLock(workbench, "daily-juno")) {
  const held = readAutonomyLock(workbench);
  log(`blocked — autonomy lock held by ${held?.holder ?? "?"} pid=${held?.pid ?? "?"}`);
  process.exit(1);
}

function cleanup() {
  try {
    writeFileSync(pidPath, "", "utf8");
  } catch {
    /* ignore */
  }
  releaseAutonomyLock(workbench);
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

if (!schedule.enabled) {
  log("daily-schedule.json enabled=false — exit");
  writeFileSync(runStatePath, `${JSON.stringify({ ...runReport, status: "disabled" }, null, 2)}\n`, "utf8");
  cleanup();
  process.exit(0);
}

const maxIter =
  schedule.maxIterationsPerDay ?? DEFAULT_AUTONOMY_LIMITS.maxSelfIterationsPerDay;
const intervalMs = schedule.tickIntervalMs ?? 120_000;
const maxIdle = schedule.maxIdleTicks ?? null;

log(`autonomyDate=${runReport.autonomyDate} maxIterations=${maxIter} interval=${intervalMs}ms`);

let idleStreak = 0;

while (true) {
  const state = readAutonomyState(workbench);
  if (state.iterationsToday >= maxIter) {
    log(`daily cap filled: ${state.iterationsToday}/${maxIter}`);
    runReport.capFilled = true;
    break;
  }

  const r = spawnSync(
    "node",
    ["scripts/juno-autonomy-tick.mjs", "--execute", "--skip-build"],
    {
      cwd: repoRoot,
      env: { ...process.env, JUNO_SKIP_ORCHESTRATOR_BUILD: "1" },
      stdio: "inherit",
      shell: false,
    },
  );

  runReport.ticks += 1;
  const after = readAutonomyState(workbench);

  let plannerDecision = null;
  try {
    plannerDecision = JSON.parse(
      readFileSync(path.join(workbench, "state", "mission-planner.json"), "utf8"),
    ).decision;
  } catch {
    /* ignore */
  }

  if (r.status === 2) {
    if (plannerDecision?.reason === "auto_queue_cap") {
      log(`auto_queue_cap — sleep and retry (${after.iterationsToday}/${maxIter})`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    if (plannerDecision?.reason === "daily_iteration_cap") {
      log(`daily cap filled via escalate (${after.iterationsToday}/${maxIter})`);
      runReport.capFilled = true;
      break;
    }
    log(`escalate (non-cap): ${plannerDecision?.reason ?? "?"} — sleep and retry`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    continue;
  }

  if (r.status !== 0) {
    log(`tick exit ${r.status} — continue (failed ticks do not count toward cap)`);
  }

  if (plannerDecision?.action === "stop") {
    idleStreak += 1;
    runReport.idleStreak = idleStreak;
    log(
      `idle stop (${idleStreak}${maxIdle != null ? `/${maxIdle}` : ", cap-only mode"}): ${plannerDecision.reason}`,
    );
    if (maxIdle != null && idleStreak >= maxIdle) {
      log("max idle ticks — stopping early (cap not fully used)");
      break;
    }
  } else {
    idleStreak = 0;
    runReport.idleStreak = 0;
  }

  if (after.iterationsToday >= maxIter) {
    runReport.capFilled = true;
    break;
  }

  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

const exportResult = runDailyExport(workbench, { repoRoot });
runReport.export = exportResult;
log(`export → ${exportResult.exportDir} (${exportResult.copiedFiles.length} files)`);
if (exportResult.errors.length) {
  for (const e of exportResult.errors) log(`export error: ${e}`);
}

if (schedule.purgeAfterRun !== false) {
  const policy = {
    runsRetentionDays: 0,
    runsKeepRecent: 3,
    stagingRetentionDays: 0,
    purgeEmptyRuns: true,
    ...schedule.purgePolicy,
  };
  const plan = planWorkbenchPurge(workbench, policy);
  const purgeResult = executeWorkbenchPurge(workbench, plan, { dryRun: false });
  runReport.purge = {
    deleted: purgeResult.deleted.length,
    bytesFreed: purgeResult.bytesFreed,
    errors: purgeResult.errors.length,
  };
  log(`purge deleted ${purgeResult.deleted.length}, freed ${(purgeResult.bytesFreed / 1024).toFixed(1)} KiB`);
}

runReport.finishedAt = new Date().toISOString();
runReport.status = "complete";
writeFileSync(runStatePath, `${JSON.stringify(runReport, null, 2)}\n`, "utf8");

const { appendDailySummary } = await import("./lib/vault-bridge-core.mjs");
appendDailySummary(workbench, {
  ticks: runReport.ticks,
  capFilled: runReport.capFilled,
  exportDir: runReport.export?.exportDir,
  purgeDeleted: runReport.purge?.deleted,
});

cleanup();
log("done");
process.exit(0);
