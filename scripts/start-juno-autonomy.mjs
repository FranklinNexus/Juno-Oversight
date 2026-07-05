#!/usr/bin/env node
/**
 * One-shot: install scheduled tasks + start daemon if idle.
 * Usage: node scripts/start-juno-autonomy.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

function log(m) {
  process.stderr.write(`[juno-autonomy] ${m}\n`);
}

const install = spawnSync(
  "powershell",
  [
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(repoRoot, "scripts", "install-juno-autonomy.ps1"),
    "-StartDaemonNow",
  ],
  { cwd: repoRoot, stdio: "inherit", shell: false },
);
if (install.status !== 0) process.exit(install.status ?? 1);

const pidPath = path.join(workbench, "state", "juno-daemon.pid");
if (existsSync(pidPath)) {
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (pid) log(`daemon pid=${pid}`);
}

log("autonomy armed — daily 0:00 + daemon at logon; queue head will auto-spawn");
