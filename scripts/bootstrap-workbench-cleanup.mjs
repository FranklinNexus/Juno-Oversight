#!/usr/bin/env node
/**
 * Bootstrap juno-workbench-cleanup-2026 — safe ephemeral artifact purge mission.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  phase,
  kind,
  criteria,
}));

const yamlLines = [
  `updated: ${new Date().toISOString()}`,
  "now:",
  ...now.map((p) =>
    [
      `  - id: juno-${p.phase}`,
      "    horizon: mission",
      `    kind: ${p.kind}`,
      `    run_kind: ${p.kind}`,
      "    repo_target: juno-overseer",
      `    mission_id: ${MISSION}`,
      `    phase_id: ${p.phase}`,
      `    prompt: executor_${p.kind === "implement" ? "implement" : p.kind === "verify" ? "verify" : "review"}`,
      "    provider: cursor_composer",
      "    max_minutes: 15",
      `    success_criteria: "${p.criteria}"`,
    ].join("\n"),
  ),
  "backlog: []",
  "",
];

const queuePath = path.join(workbench, "queue", "now.yaml");
const forceQueue = process.argv.includes("--force-queue");

if (existsSync(queuePath) && !forceQueue) {
  const existing = readFileSync(queuePath, "utf8");
  if (/now:\s*\n\s+-/.test(existing) && !/mission_id:\s*juno-workbench-cleanup-2026/.test(existing)) {
    console.log("[bootstrap:cleanup] queue busy — mission scaffold only (use --force-queue to replace now.yaml)");
    process.exit(0);
  }
}

writeFileSync(queuePath, yamlLines.join("\n"), "utf8");
console.log(`[bootstrap:cleanup] mission ${MISSION} + queue c01–c03 → ${missionDir}`);
