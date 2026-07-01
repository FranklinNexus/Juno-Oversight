#!/usr/bin/env node
/**
 * Bootstrap juno-axiom-book-2026 — 公理之书实验（~100k 字，Juno 全自主决策）
 */
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHAPTER_COUNT, CHARS_PER_CHAPTER, BOOK_MISSION_ID } from "./lib/book-decision.mjs";

const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const missionDir = path.join(workbench, "missions", BOOK_MISSION_ID);

function pad2(n) {
  return String(n).padStart(2, "0");
}

function makeItem({ id, phase, kind, criteria, dependsOn, prompt, maxMinutes }) {
  const row = {
    id,
    horizon: "mission",
    kind,
    run_kind: kind,
    repo_target: "workbench",
    mission_id: BOOK_MISSION_ID,
    phase_id: phase,
    prompt: prompt ?? (kind === "verify" ? "executor_verify" : kind === "review" || kind === "debate" ? "executor_book_review" : "executor_implement"),
    provider: "cursor_composer",
    workflow_id: "axiom-book",
    max_minutes: maxMinutes ?? (kind === "verify" ? 20 : kind === "implement" && phase.includes("write") ? 45 : 15),
    success_criteria: criteria,
  };
  if (dependsOn) row.depends_on = dependsOn;
  if (kind === "verify") row.eval_profile = "literature";
  return row;
}

function buildPhases() {
  const phases = [];
  phases.push(
    makeItem({
      id: "juno-ax00-decide",
      phase: "ax00-decide",
      kind: "implement",
      prompt: "executor_implement",
      criteria: "axioms.md + outline.md + quality-rubric.md + decision-log.md",
    }),
    makeItem({
      id: "juno-ax01-debate-axioms",
      phase: "ax01-debate-axioms",
      kind: "debate",
      dependsOn: "ax00-decide",
      criteria: "DEBATE ruling on axioms + outline",
    }),
    makeItem({
      id: "juno-ax02-review-plan",
      phase: "ax02-review-plan",
      kind: "review",
      dependsOn: "ax01-debate-axioms",
      criteria: "REVIEW_VERDICT PASS planning artifacts",
    }),
  );

  let prev = "ax02-review-plan";
  for (let c = 1; c <= CHAPTER_COUNT; c++) {
    const cn = pad2(c);
    const wPhase = `ax${pad2(3 + (c - 1) * 2)}-ch${cn}-write`;
    const rPhase = `ax${pad2(4 + (c - 1) * 2)}-ch${cn}-review`;
    const wId = `juno-${wPhase}`;
    const rId = `juno-${rPhase}`;
    phases.push(
      makeItem({
        id: wId,
        phase: wPhase,
        kind: "implement",
        prompt: "executor_book_write",
        dependsOn: prev,
        maxMinutes: 45,
        criteria: `chapters/ch${cn}.md 约 ${CHARS_PER_CHAPTER} 字；quality-rubric PASS`,
      }),
      makeItem({
        id: rId,
        phase: rPhase,
        kind: "review",
        dependsOn: wPhase,
        criteria: `REVIEW_VERDICT PASS ch${cn} tier1_ok`,
      }),
    );
    prev = rPhase;
  }

  const mergeIdx = 3 + CHAPTER_COUNT * 2;
  phases.push(
    makeItem({
      id: `juno-ax${pad2(mergeIdx)}-merge`,
      phase: "ax43-merge",
      kind: "implement",
      dependsOn: prev,
      criteria: "book/全书.md merge 全部章节",
    }),
    makeItem({
      id: `juno-ax${pad2(mergeIdx + 1)}-debate-final`,
      phase: "ax44-debate-final",
      kind: "debate",
      dependsOn: "ax43-merge",
      criteria: "DEBATE final quality tier1",
    }),
    makeItem({
      id: `juno-ax${pad2(mergeIdx + 2)}-review-final`,
      phase: "ax45-review-final",
      kind: "review",
      dependsOn: "ax44-debate-final",
      criteria: "REVIEW_VERDICT PASS 全书",
    }),
    makeItem({
      id: `juno-ax${pad2(mergeIdx + 3)}-verify`,
      phase: "ax46-verify",
      kind: "verify",
      dependsOn: "ax45-review-final",
      criteria: "book>=95000字; 20章; test PASS; STATUS COMPLETE",
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

mkdirSync(path.join(missionDir, "chapters"), { recursive: true });
mkdirSync(path.join(missionDir, "book"), { recursive: true });

writeFileSync(
  path.join(missionDir, "progress.md"),
  `# Mission Progress — ${BOOK_MISSION_ID}

| Phase | Status |
|-------|--------|
| ax00-decide | queued |
| ax01..ax46 | backlog |

**目标**：100,000 字公理之书；Juno 全自主决策（仅 charter 四条硬约束）
`,
  "utf8",
);

writeFileSync(
  path.join(missionDir, "north-star.md"),
  `# North Star — 公理之书

从 M1+A1–A5 演绎出一本十万字、第一梯队质量的中文论著。
作者仅规定 charter；其余 Juno 自决 + self-review。
`,
  "utf8",
);

const all = buildPhases();
const now = all.slice(0, 1);
const backlog = all.slice(1);

const queuePath = path.join(workbench, "queue", "now.yaml");
if (existsSync(queuePath)) {
  copyFileSync(queuePath, path.join(workbench, "queue", `now.yaml.bak-pre-book-${Date.now()}.yaml`));
}

writeFileSync(
  queuePath,
  [`updated: ${new Date().toISOString()}`, "now:", ...now.map(formatItem), "backlog:", ...backlog.map(formatItem), ""].join("\n"),
  "utf8",
);

console.log(`[axiom-book] ${now.length} now + ${backlog.length} backlog (${all.length} phases)`);
console.log(`[axiom-book] head: ${now[0]?.id}`);
