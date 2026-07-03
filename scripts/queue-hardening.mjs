#!/usr/bin/env node
/**
 * Restore / repair juno-overseer-hardening queue (h07–h11) from progress.md.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const build = spawnSync("pnpm", ["orchestrator:build"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
});
if (build.status !== 0) process.exit(build.status ?? 1);

const { repairHardeningQueue, bootstrapHardeningQueueFromSpecs } = await import(
  "../orchestrator/dist/hardening-queue.js"
);

let result = repairHardeningQueue(workbench);
if (!result.changed) {
  result = bootstrapHardeningQueueFromSpecs(workbench);
}

if (result.changed) {
  console.log(`[queue:hardening] ${result.reason}`);
  if (result.addedPhases.length) {
    console.log(`[queue:hardening] phases: ${result.addedPhases.join(", ")}`);
  }
} else {
  console.log(`[queue:hardening] ${result.reason}`);
}
