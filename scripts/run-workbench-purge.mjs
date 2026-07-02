#!/usr/bin/env node
/**
 * Safe purge of Juno ephemeral Workbench artifacts (runs/, staging/ only).
 *
 * Usage:
 *   node scripts/run-workbench-purge.mjs              # dry-run scan
 *   node scripts/run-workbench-purge.mjs --execute    # delete (requires --i-understand)
 *   node scripts/run-workbench-purge.mjs --execute --i-understand
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const execute = process.argv.includes("--execute");
const confirmed = process.argv.includes("--i-understand");

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const build = await import("node:child_process").then(({ spawnSync }) =>
  spawnSync("pnpm", ["orchestrator:build"], { cwd: repoRoot, stdio: "inherit", shell: true }),
);
if (build.status !== 0) process.exit(build.status ?? 1);

const { planWorkbenchPurge, executeWorkbenchPurge, writePurgeReport } = await import(
  "../orchestrator/dist/workbench-purge.js"
);

const plan = planWorkbenchPurge(workbench);
console.log(JSON.stringify(plan, null, 2));
console.error(
  `\n[purge] ${plan.candidates.length} candidates, ${(plan.totalBytes / 1024).toFixed(1)} KiB` +
    (plan.activeRunId ? ` (protected activeRunId=${plan.activeRunId})` : ""),
);

if (!execute) {
  console.error("[purge] dry-run only — pass --execute --i-understand to delete");
  writePurgeReport(workbench, plan);
  process.exit(0);
}

if (!confirmed) {
  console.error("[purge] BLOCKED: --execute requires --i-understand (human safety ack)");
  process.exit(2);
}

const result = executeWorkbenchPurge(workbench, plan, { dryRun: false });
const reportPath = writePurgeReport(workbench, plan, result);
console.log(JSON.stringify(result, null, 2));
console.error(
  `[purge] deleted ${result.deleted.length}, freed ${(result.bytesFreed / 1024).toFixed(1)} KiB → ${reportPath}`,
);
process.exit(result.errors.length ? 1 : 0);
