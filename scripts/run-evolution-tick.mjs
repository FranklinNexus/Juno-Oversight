#!/usr/bin/env node
/** Compute evolution fitness + append log (no Live API). */
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

const skipBuild =
  process.argv.includes("--skip-build") || process.env.JUNO_SKIP_ORCHESTRATOR_BUILD === "1";

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
  if (!skipBuild) {
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
      process.stderr.write(`[evolution] BLOCKED: ${error.message}\n`);
      return 5;
    }
    if (status !== 0) return status;
  }

  const { recordEvolutionTick } = await import("../orchestrator/dist/evolution-unit.js");
  const snap = recordEvolutionTick(workbench, { trigger: "manual", note: "pnpm evolution:tick" });
  console.log(JSON.stringify(snap, null, 2));
  return 0;
}

try {
  process.exitCode = await main();
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}
