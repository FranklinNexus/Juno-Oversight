#!/usr/bin/env node
/**
 * Run book quality REVISE loop (live write/review with programmatic gates).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnLiveBookSlot, writeBookLoopState, BOOK_MISSION_ID } from "./lib/book-advance-core.mjs";
import { needsLiveAgent } from "./lib/book-decision.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const maxArg = process.argv.find((a) => a.startsWith("--max-slots="));
const maxSlots = maxArg ? Number(maxArg.split("=")[1]) : 2;

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

function log(m) {
  process.stderr.write(`[book-quality] ${m}\n`);
}

const build = spawnSync("pnpm", ["orchestrator:build"], { cwd: repoRoot, stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const { loadProjectEnv } = await import("../orchestrator/dist/env.js");
loadProjectEnv();

const deps = {
  queueIo: await import("../orchestrator/dist/queue-io.js"),
  manifest: await import("../orchestrator/dist/manifest.js"),
  missionProgress: await import("../orchestrator/dist/mission-progress.js"),
  idempotency: await import("../orchestrator/dist/idempotency.js"),
};

let advanced = 0;
for (let i = 0; i < maxSlots; i++) {
  const { parseNowYaml } = deps.queueIo;
  const { now } = parseNowYaml(workbench);
  const head = now[0];
  if (!head) break;
  if (!needsLiveAgent(head) && !head.phase_id?.startsWith("bq-")) break;

  if (!process.env.CURSOR_API_KEY?.trim()) {
    log("blocked: CURSOR_API_KEY required");
    break;
  }

  log(`live ${head.id} (${head.phase_id})`);
  const live = await spawnLiveBookSlot(workbench, head, deps);
  if (!live.ok && !live.revised) {
    log(`failed: ${live.reason}`);
    break;
  }
  advanced += 1;
  log(live.revised ? `revise queued ${head.id}` : `done ${head.id}`);
}

writeBookLoopState(workbench, {
  status: advanced > 0 ? "idle" : "noop",
  slotsAdvancedThisRun: advanced,
  qualityLoop: true,
});

if (advanced > 0) {
  const { runSelfOptimize } = await import("../orchestrator/dist/self-optimize.js");
  runSelfOptimize(workbench);
}

log(`=== book:quality-loop done — advanced ${advanced} ===`);
process.exit(0);
