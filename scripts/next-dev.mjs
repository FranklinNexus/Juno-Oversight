#!/usr/bin/env node
/** `pnpm dev` — free port 3000, repair stale Turbopack cache, start next dev. */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repairDevCache } from "./check-dev-cache.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

repairDevCache();

const freePort = spawnSync(process.execPath, ["scripts/free-port.mjs", "3000"], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  windowsHide: true,
  timeout: 15_000,
});
if (freePort.error || freePort.status !== 0) {
  throw freePort.error ?? new Error(`free-port exited with status ${freePort.status ?? "unknown"}`);
}

const nextCli = path.join(root, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextCli, "dev", "-p", "3000", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  windowsHide: true,
  env: process.env,
});

child.once("error", (error) => {
  process.stderr.write(`[next-dev] failed to start: ${error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
