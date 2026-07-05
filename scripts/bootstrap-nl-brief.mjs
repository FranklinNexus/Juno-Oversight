#!/usr/bin/env node
/** Bootstrap juno-nl-brief-2026 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const MISSION = "juno-nl-brief-2026";
const missionDir = path.join(workbench, "missions", MISSION);
const templateDir = path.join(repoRoot, "missions-templates", MISSION);

mkdirSync(missionDir, { recursive: true });
for (const name of ["north-star.md", "scope-lock.md", "progress.md"]) {
  const src = path.join(templateDir, name);
  if (existsSync(src)) copyFileSync(src, path.join(missionDir, name));
}

const phases = [
  ["b01-brief-refine", "implement", "Enhance mission-brief.ts + juno-brief.mjs; tests"],
  ["b02-inbox-digest", "implement", "On mission COMPLETE write summary to Vault Juno/inbox/"],
  ["b03-verify", "verify", "pnpm test mission-brief + juno:brief dry-run"],
];

const yamlLines = [
  `updated: ${new Date().toISOString()}`,
  "now:",
  ...phases.map(([phase, kind, criteria]) =>
    [
      `  - id: juno-${phase}`,
      "    horizon: mission",
      `    kind: ${kind}`,
      `    run_kind: ${kind}`,
      "    repo_target: juno-overseer",
      `    mission_id: ${MISSION}`,
      `    phase_id: ${phase}`,
      `    prompt: executor_${kind === "implement" ? "implement" : "verify"}`,
      "    provider: cursor_composer",
      "    max_minutes: 45",
      `    success_criteria: "${criteria}"`,
    ].join("\n"),
  ),
  "backlog: []",
  "",
];

const queuePath = path.join(workbench, "queue", "now.yaml");
if (!process.argv.includes("--force-queue") && existsSync(queuePath)) {
  const ex = readFileSync(queuePath, "utf8");
  if (/now:\s*\n\s+-/.test(ex) && !/juno-nl-brief-2026/.test(ex)) {
    console.log("[bootstrap:nl-brief] queue busy");
    process.exit(0);
  }
}
writeFileSync(queuePath, yamlLines.join("\n"), "utf8");
console.log(`[bootstrap:nl-brief] ${MISSION} queued`);
