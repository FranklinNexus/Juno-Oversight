#!/usr/bin/env node
/**
 * Queue overnight self-improvement mission + reset daily cap + start juno:daemon.
 * Usage: node scripts/start-overnight.mjs
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const stateDir = path.join(workbench, "state");
mkdirSync(stateDir, { recursive: true });

// Overnight: higher cap until acceptance (2026-07-04)
writeFileSync(
  path.join(workbench, "config", "autonomy-limits.json"),
  `${JSON.stringify({ maxSelfIterationsPerDay: 24, note: "overnight until 2026-07-04 acceptance" }, null, 2)}\n`,
  "utf8",
);

const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  path.join(stateDir, "bounded-autonomy.json"),
  `${JSON.stringify(
    {
      date: today,
      iterationsToday: 0,
      autoQueuedToday: 0,
      lastAction: "overnight_reset",
      lastDecisionAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

writeFileSync(
  path.join(stateDir, "juno-daemon.json"),
  `${JSON.stringify({ status: "starting", overnight: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  "utf8",
);

const pidPath = path.join(stateDir, "juno-daemon.pid");
if (existsSync(pidPath)) {
  const oldPid = Number(readFileSync(pidPath, "utf8").trim());
  if (oldPid) {
    try {
      process.kill(oldPid, "SIGTERM");
      process.stderr.write(`[overnight] stopped prior daemon pid=${oldPid}\n`);
    } catch {
      /* stale */
    }
  }
  try {
    unlinkSync(pidPath);
  } catch {
    /* ignore */
  }
}

const lockPath = path.join(stateDir, "autonomy-lock.json");
if (existsSync(lockPath)) {
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

const bootstrap = spawn("node", ["scripts/bootstrap-runtime-overnight.mjs", "--force-queue"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: false,
  env: process.env,
});

bootstrap.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);

  process.stderr.write("[overnight] starting pnpm juno:daemon (120s interval)…\n");
  const daemon = spawn("pnpm", ["juno:daemon"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
    detached: process.platform !== "win32",
    env: process.env,
  });

  if (process.platform !== "win32") daemon.unref();
  daemon.on("exit", (c) => process.exit(c ?? 0));
});
