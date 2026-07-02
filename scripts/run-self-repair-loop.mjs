#!/usr/bin/env node
/**
 * Juno self-repair loop — programmatic fixes + optimize + bounded autonomy ticks.
 *
 * Usage: node scripts/run-self-repair-loop.mjs [--max-ticks=6]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const maxArg = process.argv.find((a) => a.startsWith("--max-ticks="));
const maxTicks = maxArg ? Number(maxArg.split("=")[1]) : 6;

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

function log(m) {
  process.stderr.write(`[self-repair] ${m}\n`);
}

function run(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: "inherit",
    shell: cmd === "pnpm",
  });
}

log("step 1: programmatic spaced-bold fix");
let r = run("node", ["scripts/run-book-quality-fix.mjs"]);
const fixExit = r.status ?? 1;

log("step 2: bootstrap book-quality queue if scan still failing");
run("pnpm", ["orchestrator:build"]);
const { readQualityScan } = await import("../orchestrator/dist/self-optimize.js");
const scan = readQualityScan(workbench);
if (scan?.failedChapters?.length) {
  run("node", ["scripts/bootstrap-book-quality-revise.mjs"]);
} else if (scan) {
  run("node", ["scripts/run-book-quality-loop.mjs", "--max-slots=0"]);
}

log("step 3: book quality live loop (review / semantic fixes)");
if (scan?.failedChapters?.length) {
  r = run("node", ["scripts/run-book-quality-loop.mjs", "--max-slots=2"]);
} else {
  log("skip live loop — quality scan PASS");
  r = { status: 0 };
}
const qualityExit = r.status ?? 0;

log(`step 4: autonomy ticks (max ${maxTicks})`);
let ticks = 0;
for (let i = 0; i < maxTicks; i++) {
  r = run("node", ["scripts/juno-autonomy-tick.mjs", "--execute", "--skip-build"]);
  ticks += 1;
  if (r.status === 2) {
    log("autonomy escalate — stop ticks");
    break;
  }
  if (r.status !== 0) log(`tick exit ${r.status}`);
}

const report = {
  ranAt: new Date().toISOString(),
  fixExit,
  qualityExit,
  ticks,
  remainingFails: readQualityScan(workbench)?.failedChapters ?? [],
};
mkdirSync(path.join(workbench, "state"), { recursive: true });
writeFileSync(
  path.join(workbench, "state", "self-repair.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);

log(`done — remaining fail chapters: ${report.remainingFails.join(", ") || "none"}`);
process.exit(report.remainingFails.length > 0 && qualityExit !== 0 ? 1 : 0);
