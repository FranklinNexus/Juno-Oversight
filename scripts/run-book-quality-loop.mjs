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

const { autoFixBookSpacedBoldOnly, scanBookQuality } = await import(
  "../orchestrator/dist/quality-gate.js"
);
const preFix = autoFixBookSpacedBoldOnly(workbench, { strictLength: false });
const preFixed = preFix.filter((r) => r.fixed).length;
if (preFixed > 0) log(`programmatic fix: ${preFixed} chapters`);

const deps = {
  queueIo: await import("../orchestrator/dist/queue-io.js"),
  manifest: await import("../orchestrator/dist/manifest.js"),
  missionProgress: await import("../orchestrator/dist/mission-progress.js"),
  idempotency: await import("../orchestrator/dist/idempotency.js"),
};

function clearStaleBqQueue(scan) {
  if (scan.failedChapters.length > 0) return false;
  const { parseNowYaml, saveNowQueue } = deps.queueIo;
  const { markMissionPhaseDone } = deps.missionProgress;
  let { now, backlog } = parseNowYaml(workbench);
  const stale = now.filter((h) => /^bq-ch/.test(h.phase_id ?? ""));
  if (stale.length === 0) return false;
  for (const item of stale) {
    markMissionPhaseDone(workbench, item.mission_id ?? BOOK_MISSION_ID, item.phase_id ?? "");
  }
  saveNowQueue(
    workbench,
    now.filter((h) => !/^bq-ch/.test(h.phase_id ?? "")),
    backlog,
  );
  log(`cleared ${stale.length} stale bq-* slots — scan PASS`);
  return true;
}

let scan = scanBookQuality(workbench, { strictLength: false });
if (clearStaleBqQueue(scan)) {
  writeBookLoopState(workbench, { status: "idle", slotsAdvancedThisRun: 0, qualityLoop: true, clearedStale: true });
  log("=== book:quality-loop done — stale queue cleared ===");
  process.exit(0);
}

let advanced = 0;
let failed = false;
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
    failed = true;
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

scan = scanBookQuality(workbench, { strictLength: false });
const remaining = scan.failedChapters.length;

log(`=== book:quality-loop done — advanced ${advanced}, remaining fail ${remaining || 0} ===`);
process.exit(failed || remaining > 0 ? 1 : 0);
