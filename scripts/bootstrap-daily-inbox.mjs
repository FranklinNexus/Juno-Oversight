#!/usr/bin/env node
/**
 * Bootstrap juno-daily-inbox-2026 — daily task doc in Vault Juno/inbox/ (isolated).
 * Usage: node scripts/bootstrap-daily-inbox.mjs [--force-queue]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const MISSION = "juno-daily-inbox-2026";
const missionDir = path.join(workbench, "missions", MISSION);
const templateDir = path.join(repoRoot, "missions-templates", MISSION);

mkdirSync(missionDir, { recursive: true });

for (const name of ["north-star.md", "scope-lock.md", "progress.md"]) {
  const src = path.join(templateDir, name);
  const dest = path.join(missionDir, name);
  if (existsSync(src)) copyFileSync(src, dest);
}

const cfgExample = path.join(repoRoot, "config", "daily-inbox.example.json");
const cfgDest = path.join(workbench, "config", "daily-inbox.json");
if (existsSync(cfgExample) && !existsSync(cfgDest)) {
  copyFileSync(cfgExample, cfgDest);
}

const phases = [
  [
    "i01-implement-core",
    "implement",
    "Create orchestrator/src/daily-inbox.ts + run-daily-inbox.mjs + tests; validateJunoVaultRoot (Juno/ only); generate to Juno/inbox/; delete yesterday",
  ],
  [
    "i02-integrate-daily-juno",
    "implement",
    "Hook run-daily-juno.mjs start + package.json daily:inbox; ensure idempotent same-day skip",
  ],
  [
    "i03-personalize-live",
    "implement",
    "Read Juno/inbox/_profile + 20_Projects recent notes; write 给你的三件事 in Juno/inbox/ today doc",
  ],
  [
    "i04-verify",
    "verify",
    "pnpm test (daily-inbox) + pnpm daily:inbox; VERIFY_REPORT Juno/inbox/ file exists; yesterday deleted",
  ],
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
      `    prompt: executor_${p.kind === "implement" ? "implement" : "verify"}`,
      "    provider: cursor_composer",
      "    max_minutes: 45",
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
  if (/now:\s*\n\s+-/.test(existing) && !/mission_id:\s*juno-daily-inbox-2026/.test(existing)) {
    console.log(
      "[bootstrap:daily-inbox] queue busy — scaffold only (use --force-queue to replace now.yaml)",
    );
    process.exit(0);
  }
}

writeFileSync(queuePath, yamlLines.join("\n"), "utf8");
console.log(`[bootstrap:daily-inbox] mission ${MISSION} + queue i01–i04 → ${missionDir}`);
