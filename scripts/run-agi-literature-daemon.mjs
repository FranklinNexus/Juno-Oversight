#!/usr/bin/env node
/**
 * AGI literature daemon — continuous local advance without Cursor window.
 * Runs agi:loop in a cycle until mission complete, daily cap, or fatal error.
 *
 * Usage:
 *   node scripts/run-agi-literature-daemon.mjs [--interval-ms=30000] [--max-slots=40]
 *   pnpm agi:daemon
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGI_MISSION_ID, countCompletedBatches } from "./lib/agi-advance-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const intervalArg = process.argv.find((a) => a.startsWith("--interval-ms="));
const maxSlotsArg = process.argv.find((a) => a.startsWith("--max-slots="));
const intervalMs = intervalArg ? Number(intervalArg.split("=")[1]) : 30_000;
const maxSlots = maxSlotsArg ? Number(maxSlotsArg.split("=")[1]) : 40;
const blockedIntervalMs = Math.max(intervalMs, 5 * 60_000);

const stateDir = path.join(workbench, "state");
const pidPath = path.join(stateDir, "agi-daemon.pid");
const daemonStatePath = path.join(stateDir, "agi-daemon.json");

mkdirSync(stateDir, { recursive: true });

if (existsSync(pidPath)) {
  const oldPid = Number(readFileSync(pidPath, "utf8").trim());
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, 0);
      process.stderr.write(`[agi-daemon] already running pid=${oldPid} — stop with pnpm agi:daemon:stop\n`);
      process.exit(1);
    } catch {
      /* stale pid */
    }
  }
}

writeFileSync(pidPath, String(process.pid), "utf8");

function log(msg) {
  const line = `[agi-daemon] ${msg}\n`;
  process.stderr.write(line);
}

function writeDaemonState(patch) {
  let prev = {};
  if (existsSync(daemonStatePath)) {
    try {
      prev = JSON.parse(readFileSync(daemonStatePath, "utf8"));
    } catch {
      prev = {};
    }
  }
  writeFileSync(
    daemonStatePath,
    `${JSON.stringify({ ...prev, ...patch, pid: process.pid, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

function missionComplete() {
  const cp = path.join(workbench, "missions", AGI_MISSION_ID, "checkpoint.md");
  if (!existsSync(cp)) return false;
  return /STATUS:\s*COMPLETE/i.test(readFileSync(cp, "utf8"));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runLoopOnce() {
  const r = spawnSync(
    "node",
    ["scripts/run-agi-literature-loop.mjs", `--max-slots=${maxSlots}`, "--skip-autonomy"],
    { cwd: repoRoot, encoding: "utf8", shell: false },
  );
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let cycles = 0;
let totalSlots = 0;

writeDaemonState({
  status: "running",
  startedAt: new Date().toISOString(),
  intervalMs,
  maxSlots,
  blockedIntervalMs,
});

log(`started pid=${process.pid} interval=${intervalMs}ms max-slots=${maxSlots}`);

process.on("SIGINT", () => {
  log("SIGINT — shutting down");
  writeDaemonState({ status: "stopped", stoppedAt: new Date().toISOString() });
  try {
    writeFileSync(pidPath, "", "utf8");
  } catch {
    /* ignore */
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("SIGTERM — shutting down");
  writeDaemonState({ status: "stopped", stoppedAt: new Date().toISOString() });
  process.exit(0);
});

while (true) {
  cycles += 1;

  if (missionComplete()) {
    log("mission COMPLETE — daemon exiting");
    writeDaemonState({
      status: "complete",
      cycles,
      totalSlots,
      completedBatches: countCompletedBatches(workbench),
      papersApprox: countCompletedBatches(workbench) * 25,
    });
    break;
  }

  const { status, stderr } = runLoopOnce();
  const batches = countCompletedBatches(workbench);
  const papers = batches * 25;

  let agiLoop = {};
  const agiLoopPath = path.join(stateDir, "agi-loop.json");
  if (existsSync(agiLoopPath)) {
    try {
      agiLoop = JSON.parse(readFileSync(agiLoopPath, "utf8"));
    } catch {
      agiLoop = {};
    }
  }

  const advanced = agiLoop.slotsAdvancedThisRun ?? 0;
  totalSlots += advanced;

  writeDaemonState({
    status: agiLoop.status === "blocked_missing_batch" ? "blocked" : "running",
    cycles,
    totalSlots,
    completedBatches: batches,
    papersApprox: papers,
    blockedBatch: agiLoop.blockedBatch ?? null,
    lastExitCode: status,
    lastCycleAt: new Date().toISOString(),
  });

  log(`cycle ${cycles}: advanced=${advanced} batches=${batches} (${papers} papers) exit=${status}`);

  if (status === 2) {
    log("escalate_human — daily cap or autonomy block; sleeping 1h then retry");
    await sleep(60 * 60_000);
    continue;
  }

  if (status !== 0 && status !== 3 && advanced === 0) {
    log(`loop error exit=${status} — sleep ${blockedIntervalMs / 1000}s`);
    await sleep(blockedIntervalMs);
    continue;
  }

  if (agiLoop.status === "blocked_missing_batch") {
    log(`blocked on ${agiLoop.blockedBatch} — sleep ${blockedIntervalMs / 1000}s (write batch YAML to resume)`);
    await sleep(blockedIntervalMs);
    continue;
  }

  if (advanced === 0 && status === 3) {
    log("blocked with zero advance — long sleep");
    await sleep(blockedIntervalMs);
    continue;
  }

  if (advanced === 0) {
    log("no work — sleep");
    await sleep(intervalMs);
    continue;
  }

  await sleep(intervalMs);
}

try {
  writeFileSync(pidPath, "", "utf8");
} catch {
  /* ignore */
}

log("daemon exited");
