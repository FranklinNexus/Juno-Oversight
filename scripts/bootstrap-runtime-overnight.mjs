#!/usr/bin/env node
/**
 * Bootstrap juno-runtime-overnight-2026 — self-improve until human acceptance (2026-07-04).
 * Usage: node scripts/bootstrap-runtime-overnight.mjs [--force-queue]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const MISSION = "juno-runtime-overnight-2026";
const missionDir = path.join(workbench, "missions", MISSION);
const templateDir = path.join(repoRoot, "missions-templates", MISSION);

mkdirSync(missionDir, { recursive: true });

for (const name of ["north-star.md", "scope-lock.md", "progress.md"]) {
  const src = path.join(templateDir, name);
  const dest = path.join(missionDir, name);
  if (existsSync(src)) copyFileSync(src, dest);
}

const acceptance = `# Acceptance — ${MISSION}

**Target review**: 2026-07-04

| Check | Command / artifact | Status |
|-------|-------------------|--------|
| Unit tests | \`pnpm test\` | pending |
| Desktop gate | \`pnpm verify:desktop\` (incl. dev-smoke) | pending |
| Dev HUD | \`pnpm dev\` + \`pnpm ui:smoke\` | pending |
| Smoke loop | \`pnpm loop:smoke\` | pending |
| Daemon state | \`state/juno-daemon.json\` not error | pending |
| Evolution | \`state/evolution-fitness.json\` updated | pending |

_Agent: update Status column as phases complete._
`;

writeFileSync(path.join(missionDir, "ACCEPTANCE.md"), acceptance, "utf8");

const phases = [
  ["r01-verify-desktop", "verify", "pnpm verify:desktop all PASS — VERIFY_REPORT in checkpoint"],
  [
    "r02-acceptance-doc",
    "implement",
    "Update missions/.../ACCEPTANCE.md with measured results from r01",
  ],
  ["r03-readme-review", "review", "REVIEW_VERDICT on README product positioning (Runtime/Oversight)"],
  [
    "r04-maintenance-sync",
    "implement",
    "wiki/maintenance.md matches dev-smoke + next-dev.mjs troubleshooting",
  ],
  ["r05-gap-fix", "implement", "Fix any blocking issue found in r01 or r03 (minimal diff)"],
  ["r06-evolution-tick", "verify", "pnpm evolution:tick — fitness JSON updated, VERIFY_REPORT"],
  ["r07-self-optimize", "implement", "pnpm self:optimize — quality scan + rubric if book complete"],
  ["r08-final-review", "review", "Mission final REVIEW_VERDICT PASS — ready for 2026-07-04 human review"],
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
      "    max_minutes: 30",
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
  if (/now:\s*\n\s+-/.test(existing) && !/mission_id:\s*juno-runtime-overnight-2026/.test(existing)) {
    console.log(
      "[bootstrap:overnight] queue busy — scaffold only (use --force-queue to replace now.yaml)",
    );
    process.exit(0);
  }
}

writeFileSync(queuePath, yamlLines.join("\n"), "utf8");
console.log(`[bootstrap:overnight] mission ${MISSION} + queue r01–r08 → ${missionDir}`);
