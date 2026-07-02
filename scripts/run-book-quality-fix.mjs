#!/usr/bin/env node
/**
 * Programmatic spaced-bold repair for axiom book chapters (no Live API).
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

const { autoFixBookSpacedBoldOnly, scanBookQuality } = await import(
  "../orchestrator/dist/quality-gate.js"
);
const { runSelfOptimize } = await import("../orchestrator/dist/self-optimize.js");

const results = autoFixBookSpacedBoldOnly(workbench, { strictLength: false });
const fixed = results.filter((r) => r.fixed);
const okAfter = results.filter((r) => r.okAfter);

console.log(JSON.stringify({ results, fixed: fixed.length, okAfter: okAfter.length }, null, 2));

const scan = scanBookQuality(workbench, { strictLength: false });
runSelfOptimize(workbench);

console.error(
  `[book:quality-fix] fixed ${fixed.length} chapters; scan fail: ${scan.failedChapters.join(", ") || "none"}`,
);
process.exit(scan.failedChapters.length > 0 ? 1 : 0);
