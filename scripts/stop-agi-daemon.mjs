#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { daemonStateOwnsPid, readPidLease } from "./lib/specialized-loop-guard.mjs";

const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const pidPath = path.join(workbench, "state", "agi-daemon.pid");
const statePath = path.join(workbench, "state", "agi-daemon.json");

if (!existsSync(pidPath)) {
  console.error("[agi-daemon] not running (no pid file)");
  process.exit(0);
}

const lease = readPidLease(pidPath);
if (!lease) {
  rmSync(pidPath, { force: true });
  console.error("[agi-daemon] stale pid file cleared");
  process.exit(0);
}
const { pid } = lease;

let daemonState = null;
try {
  daemonState = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
  /* fail closed below */
}
if (!daemonStateOwnsPid(daemonState, lease)) {
  console.error(`[agi-daemon] pid=${pid} is not backed by a fresh active daemon state; refusing to signal`);
  process.exit(1);
}

try {
  process.kill(pid, "SIGTERM");
  console.error(`[agi-daemon] sent SIGTERM to pid=${pid}`);
} catch (err) {
  console.error(`[agi-daemon] kill failed: ${err.message}`);
  if (err.code === "ESRCH") {
    rmSync(pidPath, { force: true });
    process.exit(0);
  }
  process.exit(1);
}
