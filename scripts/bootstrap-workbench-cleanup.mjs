#!/usr/bin/env node
/**
 * Bootstrap juno-workbench-cleanup-2026 — safe ephemeral artifact purge mission.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceQueueSnapshotSafely } from "./lib/queue-bootstrap.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const MISSION = "juno-workbench-cleanup-2026";
const missionDir = path.join(workbench, "missions", MISSION);
const templateDir = path.join(repoRoot, "missions-templates", MISSION);

mkdirSync(missionDir, { recursive: true });

for (const name of ["north-star.md", "scope-lock.md", "progress.md"]) {
  const src = path.join(templateDir, name);
  const dest = path.join(missionDir, name);
  if (existsSync(src)) copyFileSync(src, dest);
}

const phases = [
  ["c01-scan", "verify", "PURGE_PLAN dry-run — candidates listed, zero OS/repo paths"],
  ["c02-execute", "implement", "run-workbench-purge --execute --i-understand; purge-report.json written"],
  ["c03-review", "review", "REVIEW_VERDICT PASS — only runs/staging touched, missions/config intact"],
];

const now = phases.map(([phase, kind, criteria]) => ({
  id: `juno-${phase}`,
  horizon: "mission",
  kind,
  run_kind: kind,
  repo_target: "juno-overseer",
  mission_id: MISSION,
  phase_id: phase,
  prompt: `executor_${kind === "implement" ? "implement" : kind === "verify" ? "verify" : "review"}`,
  provider: "openai_codex",
  max_minutes: 15,
  success_criteria: criteria,
}));

const forceQueue = process.argv.includes("--force-queue");
const queueResult = await replaceQueueSnapshotSafely({
  workbench,
  now,
  backlog: [],
  backupPrefix: "bak-pre-cleanup",
  canReplace: forceQueue
    ? undefined
    : (snapshot) =>
        [...snapshot.now, ...snapshot.backlog].every((item) => item.mission_id === MISSION),
});
if (!queueResult.changed) {
  console.log("[bootstrap:cleanup] queue busy — mission scaffold only (use --force-queue to replace now.yaml)");
  process.exit(0);
}
console.log(`[bootstrap:cleanup] mission ${MISSION} + queue c01–c03 → ${missionDir}`);
