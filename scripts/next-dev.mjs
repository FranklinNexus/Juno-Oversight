#!/usr/bin/env node
/** `pnpm dev` — free port 3000, repair stale Turbopack cache, start next dev. */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repairDevCache } from "./check-dev-cache.mjs";
import { terminateProcessTree } from "./lib/process-tree.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextCli = path.join(root, "node_modules", "next", "dist", "bin", "next");

repairDevCache();

spawnSync("node", ["scripts/free-port.mjs", "3000"], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});

const child = spawn(process.execPath, [nextCli, "dev", "-p", "3000", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  env: process.env,
});

let shuttingDown = false;
async function stopChild(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  terminateProcessTree(child.pid);
  process.exit(exitCode);
}

process.once("SIGINT", () => void stopChild(130));
process.once("SIGTERM", () => void stopChild(143));

child.on("exit", (code, signal) => {
  if (shuttingDown) return;
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
