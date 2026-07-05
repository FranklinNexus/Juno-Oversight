#!/usr/bin/env node
/**
 * Bootstrap juno-agent-drive-research-2026 — 100 papers → drive architecture synthesis.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const MISSION = "juno-agent-drive-research-2026";
const missionDir = path.join(workbench, "missions", MISSION);
const templateDir = path.join(repoRoot, "missions-templates", MISSION);

mkdirSync(missionDir, { recursive: true });
mkdirSync(path.join(missionDir, "papers"), { recursive: true });
for (const name of ["north-star.md", "scope-lock.md", "progress.md"]) {
  const src = path.join(templateDir, name);
  if (existsSync(src)) copyFileSync(src, path.join(missionDir, name));
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

function makeItem(phase, kind, criteria, dependsOn) {
  const prompt =
    kind === "implement"
      ? phase.includes("papers") || phase.includes("taxonomy") || phase.includes("synthesis")
        ? "executor_research"
        : "executor_implement"
      : kind === "review"
        ? "executor_review"
        : "executor_verify";
  const row = {
    id: `juno-${phase}`,
    horizon: "mission",
    kind,
    run_kind: kind,
    repo_target: "juno-overseer",
    mission_id: MISSION,
    phase_id: phase,
    prompt,
    provider: "cursor_composer",
    max_minutes: kind === "verify" ? 20 : phase.includes("papers") ? 25 : 15,
    success_criteria: criteria,
  };
  if (dependsOn) row.depends_on = dependsOn;
  return row;
}

const phases = [];
phases.push(
  makeItem("dr00-taxonomy", "implement", "papers/taxonomy-drive.md — 4 batch themes + search queries"),
);

for (let b = 1; b <= 4; b++) {
  const start = (b - 1) * 25 + 1;
  const end = b * 25;
  const imp = `dr${String(2 * b - 1).padStart(2, "0")}-papers-${pad3(start)}-${pad3(end)}`;
  const rev = `dr${String(2 * b).padStart(2, "0")}-review-${pad3(start)}-${pad3(end)}`;
  phases.push(
    makeItem(imp, "implement", `papers/batch-${String(b).padStart(2, "0")}.yaml exactly 25 papers (#${start}-${end})`),
    makeItem(rev, "review", `REVIEW_VERDICT PASS batch-${String(b).padStart(2, "0")}.yaml`, imp),
  );
}

phases.push(
  makeItem(
    "dr09-synthesis",
    "implement",
    "wiki/juno-drive-architecture.md — curiosity/ambition/autonomy/metacognition → Juno components",
  ),
  makeItem(
    "dr10-implement",
    "implement",
    "Refine drive-engine + constitution + fitness per synthesis; record CHANGES",
  ),
  makeItem("dr11-verify", "verify", "pnpm test drive-engine + constitution; VERIFY_REPORT PASS"),
);

const queuePath = path.join(workbench, "queue", "now.yaml");
if (!process.argv.includes("--force-queue") && existsSync(queuePath)) {
  const ex = readFileSync(queuePath, "utf8");
  if (/now:\s*\n\s+-/.test(ex) && !/juno-agent-drive-research-2026/.test(ex)) {
    console.log("[bootstrap:agent-drive-research] queue busy — use --force-queue");
    process.exit(0);
  }
}

function itemYaml(item, indent) {
  const lines = [`${indent}- id: ${item.id}`];
  for (const [k, v] of Object.entries(item)) {
    if (k === "id") continue;
    lines.push(`${indent}  ${k}: ${typeof v === "string" ? `"${String(v).replace(/"/g, '\\"')}"` : v}`);
  }
  return lines.join("\n");
}

const nowItems = phases.slice(0, 3);
const backlogItems = phases.slice(3);
writeFileSync(
  queuePath,
  [
    `updated: ${new Date().toISOString()}`,
    "now:",
    ...nowItems.map((p) => itemYaml(p, "  ")),
    "backlog:",
    ...backlogItems.map((p) => itemYaml(p, "  ")),
    "",
  ].join("\n"),
  "utf8",
);

console.log(
  `[bootstrap:agent-drive-research] ${MISSION} — ${phases.length} phases (3 now + ${backlogItems.length} backlog)`,
);
