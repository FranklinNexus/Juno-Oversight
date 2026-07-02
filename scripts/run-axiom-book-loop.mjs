#!/usr/bin/env node
/**
 * Axiom book loop — local planning + live chapter write/review.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  advanceOneBookSlot,
  spawnLiveBookSlot,
  writeBookLoopState,
  BOOK_MISSION_ID,
} from "./lib/book-advance-core.mjs";
import { countBookHan, needsLiveAgent } from "./lib/book-decision.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const maxArg = process.argv.find((a) => a.startsWith("--max-slots="));
const maxSlots = maxArg ? Number(maxArg.split("=")[1]) : 3;
const skipAutonomy = process.argv.includes("--skip-autonomy");

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

function log(m) {
  process.stderr.write(`[book-loop] ${m}\n`);
}

const build = spawnSync("pnpm", ["orchestrator:build"], { cwd: repoRoot, stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const { loadProjectEnv } = await import("../orchestrator/dist/env.js");
loadProjectEnv();

let recordAutonomyDecision;
let decideNextAction;
if (!skipAutonomy) {
  ({ recordAutonomyDecision, decideNextAction } = await import("../orchestrator/dist/bounded-autonomy.js"));
  const decision = decideNextAction(workbench);
  if (decision.action === "escalate_human") {
    log(`BLOCKED: ${decision.reason}`);
    writeBookLoopState(workbench, { status: "escalate_human", decision });
    process.exit(2);
  }
  if (decision.action === "queue_mission" && decision.bootstrap === "queue:axiom-book") {
    spawnSync("node", ["scripts/bootstrap-axiom-book.mjs"], { cwd: repoRoot, stdio: "inherit" });
  }
  if (decision.action === "run_book_loop" || decision.action === "queue_mission") {
    recordAutonomyDecision(workbench, {
      action: "run_book_loop",
      missionId: BOOK_MISSION_ID,
      script: "book:loop",
      reason: "axiom book advance",
    });
  }
}

const deps = {
  queueIo: await import("../orchestrator/dist/queue-io.js"),
  manifest: await import("../orchestrator/dist/manifest.js"),
  missionProgress: await import("../orchestrator/dist/mission-progress.js"),
  idempotency: await import("../orchestrator/dist/idempotency.js"),
};

let advanced = 0;
let blocked = null;

for (let i = 0; i < maxSlots; i++) {
  const { parseNowYaml, saveNowQueue } = deps.queueIo;
  let { now, backlog } = parseNowYaml(workbench);
  if (now.length === 0) {
    const promoted = backlog.filter((item) => item.mission_id === BOOK_MISSION_ID).slice(0, 1);
    if (promoted.length === 0) break;
    const ids = new Set(promoted.map((p) => p.id));
    backlog = backlog.filter((item) => !ids.has(item.id));
    now = promoted;
    saveNowQueue(workbench, now, backlog);
  }
  const head = now[0];
  if (!head || head.mission_id !== BOOK_MISSION_ID) break;

  if (needsLiveAgent(head)) {
    if (!process.env.CURSOR_API_KEY?.trim()) {
      blocked = { reason: "need CURSOR_API_KEY for live chapter slot", phase: head.phase_id };
      log(`blocked: ${blocked.reason} (${head.phase_id})`);
      break;
    }
    log(`live spawn ${head.id} (${head.phase_id})`);
    const live = await spawnLiveBookSlot(workbench, head, deps);
    if (!live.ok) {
      blocked = { reason: live.reason, phase: head.phase_id };
      log(`live failed: ${live.reason}`);
      break;
    }
    advanced += 1;
    log(`live done ${head.id}${live.revised ? " (REVISE fix queued)" : ""}`);
    continue;
  }

  const r = await advanceOneBookSlot(workbench, deps);
  if (r.advanced) {
    advanced += 1;
    log(`dequeued ${r.runId} (${r.runKind})`);
    continue;
  }
  if (r.needLive) {
    blocked = { reason: r.reason, phase: head.phase_id };
    break;
  }
  log(`stop: ${r.reason}`);
  break;
}

const han = countBookHan(workbench);
writeBookLoopState(workbench, {
  status: blocked ? "blocked" : advanced > 0 ? "idle" : "noop",
  slotsAdvancedThisRun: advanced,
  bookHanApprox: han,
  blockedReason: blocked?.reason ?? null,
  blockedPhase: blocked?.phase ?? null,
});

log(`=== book:loop done — advanced ${advanced}, bookHan≈${han} ===`);
process.exit(blocked && advanced === 0 ? 3 : 0);
