#!/usr/bin/env node
/**
 * Restore / repair juno-overseer-hardening queue (h07–h11) from progress.md.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpmWithTimeout } from "./lib/pnpm-runner.mjs";
import {
  BUILD_TIMEOUT_MS,
  checkedSpawnStatus,
} from "./lib/specialized-loop-guard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const shutdownController = new AbortController();
let stopSignal = null;
const requestStop = (signal) => {
  if (stopSignal) return;
  stopSignal = signal;
  shutdownController.abort();
};
const onSigint = () => requestStop("SIGINT");
const onSigterm = () => requestStop("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

async function main() {
  const build = await spawnPnpmWithTimeout(
    ["orchestrator:build"],
    { cwd: repoRoot, stdio: "inherit", signal: shutdownController.signal },
    BUILD_TIMEOUT_MS,
  );
  if (stopSignal) return stopSignal === "SIGINT" ? 130 : 143;
  let status;
  try {
    status = checkedSpawnStatus(build, "orchestrator build");
  } catch (error) {
    process.stderr.write(`[queue:hardening] BLOCKED: ${error.message}\n`);
    return 5;
  }
  if (status !== 0) return status;

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
  return 0;
}

try {
  process.exitCode = await main();
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}
