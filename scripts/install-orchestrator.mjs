#!/usr/bin/env node
/** Install orchestrator deps from orchestrator/ cwd — avoids npm --prefix auto-linking parent juno-hud. */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const orchDir = path.join(root, "orchestrator");

const result = spawnSync("npm", ["install"], {
  cwd: orchDir,
  stdio: "inherit",
  shell: true,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
