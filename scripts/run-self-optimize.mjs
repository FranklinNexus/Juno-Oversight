#!/usr/bin/env node
/**
 * Self-optimize tick: scan book quality, patch rubric, select workflow, refresh MCP hints.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpmWithTimeout } from "./lib/pnpm-runner.mjs";
import {
  BOOTSTRAP_TIMEOUT_MS,
  BUILD_TIMEOUT_MS,
  checkedSpawnStatus,
  spawnWithTimeout,
} from "./lib/specialized-loop-guard.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");

export async function runSelfOptimizeEntrypoint(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const workbench = options.workbench ?? process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
  const spawnBuild = options.spawnBuild ?? spawnPnpmWithTimeout;
  const spawnBootstrap = options.spawnBootstrap ?? spawnWithTimeout;
  const log = options.log ?? console.log;
  const writeError = options.writeError ?? ((message) => process.stderr.write(message));

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

  try {
    const build = await spawnBuild(
      ["orchestrator:build"],
      { cwd: repoRoot, stdio: "inherit", signal: shutdownController.signal },
      BUILD_TIMEOUT_MS,
    );
    if (stopSignal) return stopSignal === "SIGINT" ? 130 : 143;
    let status;
    try {
      status = checkedSpawnStatus(build, "orchestrator build");
    } catch (error) {
      writeError(`[self-optimize] BLOCKED: ${error.message}\n`);
      return 5;
    }
    if (status !== 0) return status;

    const runSelfOptimize = options.runSelfOptimize ??
      (await import("../orchestrator/dist/self-optimize.js")).runSelfOptimize;
    const report = runSelfOptimize(workbench);
    log(JSON.stringify(report, null, 2));

    if (
      report.autoQueueBookRevise !== true ||
      !report.qualityScan?.failedChapters.length
    ) {
      return 0;
    }
    const boot = await spawnBootstrap(
      process.execPath,
      ["scripts/bootstrap-book-quality-revise.mjs"],
      { cwd: repoRoot, stdio: "inherit", signal: shutdownController.signal },
      BOOTSTRAP_TIMEOUT_MS,
    );
    if (stopSignal) return stopSignal === "SIGINT" ? 130 : 143;
    try {
      return checkedSpawnStatus(boot, "book quality bootstrap");
    } catch (error) {
      writeError(`[self-optimize] BLOCKED: ${error.message}\n`);
      return 5;
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

function isMainModule() {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath));
}

if (isMainModule()) {
  runSelfOptimizeEntrypoint()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      process.stderr.write(
        `[self-optimize] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
