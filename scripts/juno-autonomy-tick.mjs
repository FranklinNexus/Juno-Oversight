#!/usr/bin/env node
/**
 * Bounded autonomy tick: decide + optionally bootstrap next mission.
 * Usage: node scripts/juno-autonomy-tick.mjs [--execute]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const execute = process.argv.includes("--execute");

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const build = spawnSync("pnpm", ["orchestrator:build"], { cwd: repoRoot, stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const { loadProjectEnv } = await import("../orchestrator/dist/env.js");
loadProjectEnv();

const { decideNextAction, recordAutonomyDecision } = await import(
  "../orchestrator/dist/bounded-autonomy.js"
);

const decision = decideNextAction(workbench);
console.log(JSON.stringify(decision, null, 2));

if (!execute) {
  console.error("\n[dry-run] pass --execute to apply (respects daily caps)");
  process.exit(0);
}

recordAutonomyDecision(workbench, decision);

if (decision.action === "run_local_loop") {
  const r = spawnSync("pnpm", [decision.script], { cwd: repoRoot, stdio: "inherit", shell: true });
  process.exit(r.status ?? 1);
}

if (decision.action === "run_agi_loop") {
  const r = spawnSync("node", ["scripts/run-agi-literature-loop.mjs", "--skip-autonomy"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

if (decision.action === "run_book_loop") {
  const r = spawnSync("node", ["scripts/run-axiom-book-loop.mjs", "--skip-autonomy", "--max-slots=2"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

if (decision.action === "queue_mission") {
  if (decision.bootstrap === "queue:agi-literature") {
    const r = spawnSync("node", ["scripts/bootstrap-agi-literature.mjs"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    process.exit(r.status ?? 1);
  }
  if (decision.bootstrap === "queue:axiom-book") {
    const r = spawnSync("node", ["scripts/bootstrap-axiom-book.mjs"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    process.exit(r.status ?? 1);
  }
  process.exit(1);
}

if (decision.action === "escalate_human") {
  console.error(`[autonomy] HUMAN REQUIRED: ${decision.reason} — ${decision.detail}`);
  process.exit(2);
}

process.exit(0);
