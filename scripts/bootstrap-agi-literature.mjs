#!/usr/bin/env node
/**
 * Bootstrap juno-agi-literature-2026: 1000 papers / 40 batches.
 * Queues ag00–ag02 in now; ag03–ag83 in backlog.
 */
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const missionId = "juno-agi-literature-2026";
const missionDir = path.join(workbench, "missions", missionId);

function pad2(n) {
  return String(n).padStart(2, "0");
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

function makeItem({ id, phase, kind, criteria, dependsOn, evalProfile }) {
  let prompt = "executor_review";
  if (kind === "implement") {
    if (phase.includes("taxonomy")) prompt = "executor_implement";
    else if (phase.includes("papers")) prompt = "executor_research";
    else prompt = "executor_implement";
  } else if (kind === "verify") {
    prompt = "executor_verify";
  }
  const row = {
    id,
    horizon: "mission",
    kind,
    run_kind: kind,
    repo_target: "juno-overseer",
    mission_id: missionId,
    phase_id: phase,
    prompt,
    provider: "cursor_composer",
    workflow_id: "default",
    max_minutes: kind === "verify" ? 15 : phase.includes("papers") ? 20 : 12,
    success_criteria: criteria,
  };
  if (dependsOn) row.depends_on = dependsOn;
  if (evalProfile) row.eval_profile = evalProfile;
  return row;
}

function buildPhases() {
  const phases = [];
  phases.push(
    makeItem({
      id: "juno-ag00-taxonomy",
      phase: "ag00-taxonomy",
      kind: "implement",
      criteria: "taxonomy-agi.md + papers/README (40 batches × 25)",
    }),
  );

  for (let b = 1; b <= 40; b++) {
    const start = (b - 1) * 25 + 1;
    const end = b * 25;
    const impPhase = `ag${pad2(2 * b - 1)}-papers-${pad3(start)}-${pad3(end)}`;
    const revPhase = `ag${pad2(2 * b)}-review-${pad3(start)}-${pad3(end)}`;
    const batchFile = `batch-${pad2(b)}.yaml`;
    phases.push(
      makeItem({
        id: `juno-${impPhase}`,
        phase: impPhase,
        kind: "implement",
        criteria: `papers/${batchFile} 恰好 25 篇 (#${start}-${end})`,
      }),
      makeItem({
        id: `juno-${revPhase}`,
        phase: revPhase,
        kind: "review",
        criteria: `REVIEW_VERDICT PASS ${batchFile}`,
        dependsOn: impPhase,
      }),
    );
  }

  phases.push(
    makeItem({
      id: "juno-ag81-synthesis",
      phase: "ag81-synthesis",
      kind: "implement",
      criteria: "wiki/juno-agi-north-star.md 初步 AGI 架构 + 1000 篇映射",
    }),
    makeItem({
      id: "juno-ag82-review-synthesis",
      phase: "ag82-review-synthesis",
      kind: "review",
      criteria: "REVIEW_VERDICT PASS AGI north-star",
      dependsOn: "ag81-synthesis",
    }),
    makeItem({
      id: "juno-ag83-verify",
      phase: "ag83-verify",
      kind: "verify",
      criteria: "papers>=1000; wiki/juno-agi-north-star.md; test+deps PASS",
      dependsOn: "ag82-review-synthesis",
      evalProfile: "literature",
    }),
  );
  return phases;
}

function yamlQuote(v) {
  const s = String(v);
  if (/^[a-zA-Z0-9_./:-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatItem(it) {
  const lines = [`  - id: ${yamlQuote(it.id)}`];
  for (const [k, v] of Object.entries(it)) {
    if (k === "id" || v == null) continue;
    if (k === "max_minutes") lines.push(`    max_minutes: ${v}`);
    else lines.push(`    ${k}: ${yamlQuote(String(v))}`);
  }
  return lines.join("\n");
}

mkdirSync(path.join(missionDir, "papers"), { recursive: true });

const all = buildPhases();
const now = all.slice(0, 3);
const backlog = all.slice(3);

const queuePath = path.join(workbench, "queue", "now.yaml");
if (existsSync(queuePath)) {
  copyFileSync(queuePath, path.join(workbench, "queue", `now.yaml.bak-pre-agi-${Date.now()}.yaml`));
}

writeFileSync(
  queuePath,
  [
    `updated: ${new Date().toISOString()}`,
    "now:",
    ...now.map(formatItem),
    "backlog:",
    ...backlog.map(formatItem),
    "",
  ].join("\n"),
  "utf8",
);

console.log(`[agi-literature] ${now.length} now + ${backlog.length} backlog (${all.length} phases)`);
console.log(`[agi-literature] now head: ${now[0]?.id}`);
