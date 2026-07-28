#!/usr/bin/env node
/**
 * One-shot: install scheduled tasks + start daemon if idle.
 * Usage: node scripts/start-juno-autonomy.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultWorkbenchRoot, loadProjectEnv } from "./lib/project-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(repoRoot);
const workbench = defaultWorkbenchRoot();

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

const pidPath = path.join(workbench, "state", "daemon.pid");
if (existsSync(pidPath)) {
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (pid) log(`scheduler pid=${pid}`);
}

log("runtime armed — one scheduler at logon; queue head will auto-spawn");
