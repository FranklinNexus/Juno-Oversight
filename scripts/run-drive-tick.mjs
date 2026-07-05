#!/usr/bin/env node
/**
 * Drive engine tick — scan, digest, optional auto-queue.
 * Usage: pnpm drive:tick [--execute] [--auto-queue]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const execute = process.argv.includes("--execute");
const autoQueue = process.argv.includes("--auto-queue") || execute;

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

if (!process.argv.includes("--skip-build")) {
  const build = spawnSync("pnpm", ["orchestrator:build"], { cwd: repoRoot, stdio: "inherit", shell: true });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const { runDriveTick } = await import("../orchestrator/dist/drive-engine.js");

const result = runDriveTick(workbench, repoRoot, { autoQueue: autoQueue && execute });

console.log(JSON.stringify(result, null, 2));

if (result.digestPath) {
  process.stderr.write(`[drive:tick] digest → ${result.digestPath}\n`);
}

process.exit(0);
