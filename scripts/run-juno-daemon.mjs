#!/usr/bin/env node
/**
 * Juno master daemon — bounded autonomy tick in a loop (Juno moves itself).
 *
 * Usage: pnpm juno:daemon [--interval-ms=120000]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const intervalArg = process.argv.find((a) => a.startsWith("--interval-ms="));
const intervalMs = intervalArg ? Number(intervalArg.split("=")[1]) : 120_000;

const stateDir = path.join(workbench, "state");
const pidPath = path.join(stateDir, "juno-daemon.pid");
const daemonStatePath = path.join(stateDir, "juno-daemon.json");

mkdirSync(stateDir, { recursive: true });

const buildOnce = spawnSync("pnpm", ["orchestrator:build"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
});
if (buildOnce.status !== 0) process.exit(buildOnce.status ?? 1);

const { acquireAutonomyLock, releaseAutonomyLock, readAutonomyLock } = await import(
  "../orchestrator/dist/autonomy-lock.js"
);
const { msUntilNextAutonomyDay } = await import("../orchestrator/dist/autonomy-day.js");

if (!acquireAutonomyLock(workbench, "juno-daemon")) {
  const held = readAutonomyLock(workbench);
  process.stderr.write(
    `[juno-daemon] blocked — autonomy lock held by ${held?.holder ?? "?"} pid=${held?.pid ?? "?"}\n`,
  );
  process.exit(1);
}

if (existsSync(pidPath)) {
  const oldPid = Number(readFileSync(pidPath, "utf8").trim());
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, 0);
      process.stderr.write(`[juno-daemon] already running pid=${oldPid}\n`);
      releaseAutonomyLock(workbench);
      process.exit(1);
    } catch {
      /* stale */
    }
  }
}

writeFileSync(pidPath, String(process.pid), "utf8");

function log(msg) {
  process.stderr.write(`[juno-daemon] ${msg}\n`);
}

function writeState(patch) {
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
    `${JSON.stringify({ ...prev, ...patch, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

function onExit() {
  try {
    writeFileSync(pidPath, "", "utf8");
  } catch {
    /* ignore */
  }
  releaseAutonomyLock(workbench);
}

process.on("SIGINT", () => {
  log("SIGINT — exit");
  onExit();
  process.exit(0);
});
process.on("SIGTERM", () => {
  log("SIGTERM — exit");
  onExit();
  process.exit(0);
});

log(`started pid=${process.pid} interval=${intervalMs}ms`);

while (true) {
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

  writeState({ lastExit: r.status ?? 0, status: "running" });

  if (r.status === 2) {
    try {
      const planner = JSON.parse(
        readFileSync(path.join(workbench, "state", "mission-planner.json"), "utf8"),
      );
      if (planner.decision?.reason === "daily_iteration_cap") {
        const waitMs = msUntilNextAutonomyDay(workbench);
        const nextAt = new Date(Date.now() + waitMs).toISOString();
        log(`daily cap reached (${planner.decision.detail ?? ""}) — sleep until next day (~${Math.round(waitMs / 60_000)} min, ~${nextAt})`);
        writeState({ status: "waiting_midnight", waitUntil: nextAt, lastCapDetail: planner.decision.detail });
        const chunkMs = 5 * 60_000;
        let remaining = waitMs;
        while (remaining > 0) {
          const slice = Math.min(chunkMs, remaining);
          await new Promise((resolve) => setTimeout(resolve, slice));
          remaining -= slice;
          writeState({
            status: "waiting_midnight",
            waitUntil: nextAt,
            heartbeatAt: new Date().toISOString(),
            waitRemainingMs: remaining,
          });
        }
        log("autonomy day reset — resume ticks");
        writeState({ status: "running", waitUntil: null });
        continue;
      }
    } catch {
      /* ignore */
    }
    log("escalate_human — sleeping until next interval");
  }

  if (r.status === 0) {
    try {
      const planner = JSON.parse(
        readFileSync(path.join(workbench, "state", "mission-planner.json"), "utf8"),
      );
      if (planner.decision?.action === "stop") {
        log(`idle: ${planner.decision.reason}`);
      }
    } catch {
      /* ignore */
    }
  }

  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
