#!/usr/bin/env node
/**
 * Self-optimize tick: scan book quality, patch rubric, select workflow, refresh MCP hints.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const build = spawnSync("pnpm", ["orchestrator:build"], { cwd: repoRoot, stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const { runSelfOptimize } = await import("../orchestrator/dist/self-optimize.js");
const report = runSelfOptimize(workbench);
console.log(JSON.stringify(report, null, 2));

if (report.qualityScan?.failedChapters.length) {
  const boot = spawnSync("node", ["scripts/bootstrap-book-quality-revise.mjs"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  process.exit(boot.status ?? 0);
}

process.exit(0);
