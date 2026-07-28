#!/usr/bin/env node
/** Start the single Juno scheduler detached and without a visible console. */
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { quietSpawnOpts, runOrchestratorBuild } from "./lib/win-spawn.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const pidPath = path.join(workbench, "state", "daemon.pid");
const skipBuild = process.argv.includes("--skip-build");

function livePid() {
  if (!existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

const existing = livePid();
if (existing) {
  process.stderr.write(`[juno-scheduler-start] already running pid=${existing}\n`);
  process.exit(0);
}

if (!skipBuild) {
  const build = runOrchestratorBuild(repoRoot);
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const logFd = openSync(path.join(workbench, "state", "scheduler.log"), "a");
const child = spawn(
  process.execPath,
  [path.join(repoRoot, "orchestrator", "dist", "scheduler-daemon.js")],
  quietSpawnOpts(repoRoot, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      AGENT_WORKBENCH_ROOT: workbench,
      JUNO_OVERSIGHT_ROOT: repoRoot,
      JUNO_NODE_PATH: process.execPath,
    },
  }),
);

child.unref();
if (!child.pid) {
  process.stderr.write("[juno-scheduler-start] failed to start\n");
  process.exit(1);
}
process.stderr.write(`[juno-scheduler-start] started detached pid=${child.pid}\n`);
