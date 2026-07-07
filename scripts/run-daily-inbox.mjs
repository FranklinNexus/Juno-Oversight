#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

if (!process.argv.includes("--skip-build")) {
  const b = spawnSync("pnpm", ["orchestrator:build"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

const { generateDailyInbox } = await import("../orchestrator/dist/daily-inbox.js");
const result = generateDailyInbox(workbench);
console.log(JSON.stringify(result, null, 2));
if (result.filePath) {
  process.stderr.write(`[daily-inbox] ${result.status} -> ${result.filePath}\n`);
}
