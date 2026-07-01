#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const pidPath = path.join(workbench, "state", "agi-daemon.pid");

if (!existsSync(pidPath)) {
  console.error("[agi-daemon] not running (no pid file)");
  process.exit(0);
}

const pid = Number(readFileSync(pidPath, "utf8").trim());
if (!pid) {
  writeFileSync(pidPath, "", "utf8");
  console.error("[agi-daemon] stale pid file cleared");
  process.exit(0);
}

try {
  process.kill(pid, "SIGTERM");
  console.error(`[agi-daemon] sent SIGTERM to pid=${pid}`);
} catch (err) {
  console.error(`[agi-daemon] kill failed: ${err.message}`);
}

writeFileSync(pidPath, "", "utf8");
