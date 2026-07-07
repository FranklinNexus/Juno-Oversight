#!/usr/bin/env node
/**
 * Detached, windowless Juno daemon launcher (Windows-safe).
 * Usage: node scripts/start-juno-daemon-hidden.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemonDetached } from "./lib/win-spawn.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const pidPath = path.join(workbench, "state", "juno-daemon.pid");

function log(msg) {
  process.stderr.write(`[juno-daemon-start] ${msg}\n`);
}

if (existsSync(pidPath)) {
  const raw = readFileSync(pidPath, "utf8").trim();
  const old = Number(raw);
  if (old > 0) {
    try {
      process.kill(old, 0);
      log(`already running pid=${old}`);
      process.exit(0);
    } catch {
      /* stale pid */
    }
  }
}

const pid = startDaemonDetached(repoRoot, workbench);
if (!pid) {
  log("failed to start daemon");
  process.exit(1);
}

log(`started detached pid=${pid} (no window — log: state/juno-daemon.log)`);
