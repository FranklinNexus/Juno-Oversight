#!/usr/bin/env node
/** Install orchestrator deps from orchestrator/ cwd — avoids npm --prefix auto-linking parent juno-hud. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnNpm } from "./lib/win-spawn.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const orchDir = path.join(root, "orchestrator");

const result = spawnNpm(["install"], { cwd: orchDir, stdio: "inherit" });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
