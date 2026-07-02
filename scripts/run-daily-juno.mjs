#!/usr/bin/env node
/**
 * Daily Juno batch — fill autonomy cap, export to isolated folder, purge ephemeral runs.
 *
 * Usage:
 *   node scripts/run-daily-juno.mjs              # run now (one-shot)
 *   node scripts/run-daily-juno.mjs --dry-run    # plan only, no ticks/purge
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
const { runDailyExport } = await import("../orchestrator/dist/daily-export.js");
const { planWorkbenchPurge, executeWorkbenchPurge } = await import(
  "../orchestrator/dist/workbench-purge.js"
);

const schedule = loadDailySchedule(workbench);
const stateDir = path.join(workbench, "state");
const runStatePath = path.join(stateDir, "daily-juno.json");
const pidPath = path.join(stateDir, "daily-juno.pid");

mkdirSync(stateDir, { recursive: true });

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

const runReport = {
  startedAt: new Date().toISOString(),
  dryRun,
  schedule: { exportRoot: schedule.exportRoot, maxIterationsPerDay: schedule.maxIterationsPerDay },
  ticks: 0,
  capFilled: false,
  idleStreak: 0,
  export: null,
  purge: null,
};

if (!schedule.enabled) {
  log("daily-schedule.json enabled=false — exit");
  writeFileSync(runStatePath, `${JSON.stringify({ ...runReport, status: "disabled" }, null, 2)}\n`, "utf8");
  process.exit(0);
}

const maxIter =
  schedule.maxIterationsPerDay ?? DEFAULT_AUTONOMY_LIMITS.maxSelfIterationsPerDay;
const intervalMs = schedule.tickIntervalMs ?? 120_000;
const maxIdle = schedule.maxIdleTicks ?? 5;

log(`maxIterations=${maxIter} interval=${intervalMs}ms exportRoot=${schedule.exportRoot}`);

if (!dryRun) {
  let idleStreak = 0;

  while (true) {
    const state = readAutonomyState(workbench);
    if (state.iterationsToday >= maxIter) {
      log(`daily cap filled: ${state.iterationsToday}/${maxIter}`);
      runReport.capFilled = true;
      break;
    }

    const r = spawnSync("node", ["scripts/juno-autonomy-tick.mjs", "--execute"], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: "inherit",
      shell: false,
    });

    runReport.ticks += 1;
    const after = readAutonomyState(workbench);

    if (r.status === 2) {
      log(`escalate (likely cap): ${after.iterationsToday}/${maxIter}`);
      runReport.capFilled = after.iterationsToday >= maxIter;
      break;
    }

    if (r.status !== 0) {
      log(`tick exit ${r.status} — continue`);
    }

    try {
      const planner = JSON.parse(
        readFileSync(path.join(workbench, "state", "mission-planner.json"), "utf8"),
      );
      if (planner.decision?.action === "stop") {
        idleStreak += 1;
        runReport.idleStreak = idleStreak;
        log(`idle stop (${idleStreak}/${maxIdle}): ${planner.decision.reason}`);
        if (idleStreak >= maxIdle) {
          log("max idle ticks — stopping early (cap not fully used)");
          break;
        }
      } else {
        idleStreak = 0;
        runReport.idleStreak = 0;
      }
    } catch {
      /* ignore */
    }

    if (after.iterationsToday >= maxIter) {
      runReport.capFilled = true;
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const exportResult = dryRun
  ? { exportDir: "(dry-run)", digestPath: "", copiedFiles: [], prunedOldExports: [], errors: [] }
  : runDailyExport(workbench, { repoRoot });

runReport.export = exportResult;
log(`export → ${exportResult.exportDir} (${exportResult.copiedFiles.length} files)`);
if (exportResult.errors.length) {
  for (const e of exportResult.errors) log(`export error: ${e}`);
}

if (!dryRun && schedule.purgeAfterRun !== false) {
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

try {
  writeFileSync(pidPath, "", "utf8");
} catch {
  /* ignore */
}

log("done");
process.exit(0);
