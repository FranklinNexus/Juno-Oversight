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

if (existsSync(pidPath)) {
  const oldPid = Number(readFileSync(pidPath, "utf8").trim());
  if (oldPid && oldPid !== process.pid) {
    try {
      process.kill(oldPid, 0);
      process.stderr.write(`[juno-daemon] already running pid=${oldPid}\n`);
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

log(`started pid=${process.pid} interval=${intervalMs}ms`);

while (true) {
  const r = spawnSync("node", ["scripts/juno-autonomy-tick.mjs", "--execute"], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: "inherit",
    shell: false,
  });

  writeState({ lastExit: r.status ?? 0, status: "running" });

  if (existsSync(daemonStatePath)) {
    try {
      const s = JSON.parse(readFileSync(daemonStatePath, "utf8"));
      if (s.status === "complete") {
        log("mission COMPLETE — exit");
        break;
      }
    } catch {
      /* ignore */
    }
  }

  if (r.status === 2) {
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

try {
  writeFileSync(pidPath, "", "utf8");
} catch {
  /* ignore */
}
