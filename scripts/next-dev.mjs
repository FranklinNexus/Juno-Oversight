#!/usr/bin/env node
/** `pnpm dev` — free port 3000, repair stale Turbopack cache, start next dev. */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repairDevCache } from "./check-dev-cache.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

repairDevCache();

spawnSync("node", ["scripts/free-port.mjs", "3000"], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});

const child = spawn("next", ["dev", "-p", "3000", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
