#!/usr/bin/env node
/**
 * Queue REVISE slots for chapters failing quality-scan.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const MISSION = "juno-book-quality-2026";
const BOOK = "juno-axiom-book-2026";

const scanPath = path.join(workbench, "state", "quality-scan.json");
if (!existsSync(scanPath)) {
  console.error("[bootstrap] missing quality-scan.json — run pnpm self:optimize first");
  process.exit(1);
}

const scan = JSON.parse(readFileSync(scanPath, "utf8"));
const failed = scan.failedChapters ?? [];
if (failed.length === 0) {
  console.log("[bootstrap] no failed chapters");
  process.exit(0);
}

const missionDir = path.join(workbench, "missions", MISSION);
mkdirSync(missionDir, { recursive: true });

const now = [];
for (const ch of failed) {
  const n = String(ch).padStart(2, "0");
  const issues =
    scan.reports?.find((r) => r.chapter === ch)?.issues?.filter((i) => i.severity === "fail") ?? [];
  const mustFix = issues.map((i) => `${i.code}: ${i.message}`).join("; ");
  now.push({
    id: `juno-bq-ch${n}-revise`,
    horizon: "mission",
    kind: "implement",
    run_kind: "implement",
    repo_target: "workbench",
    prompt: "executor_book_write",
    provider: "cursor_composer",
    max_minutes: 30,
    mission_id: BOOK,
    phase_id: `bq-ch${n}-revise`,
    success_criteria: `REVISE ch${n}: ${mustFix}`,
  });
  now.push({
    id: `juno-bq-ch${n}-review`,
    horizon: "mission",
    kind: "review",
    run_kind: "review",
    repo_target: "workbench",
    prompt: "executor_book_review",
    provider: "cursor_composer",
    max_minutes: 15,
    mission_id: BOOK,
    phase_id: `bq-ch${n}-review`,
    success_criteria: "REVIEW_VERDICT + programmatic quality-gate PASS",
  });
}

writeFileSync(
  path.join(missionDir, "north-star.md"),
  `# North Star — ${MISSION}\n\nProgrammatic quality REVISE for axiom book failed chapters.\n`,
  "utf8",
);
writeFileSync(
  path.join(missionDir, "progress.md"),
  `# Mission Progress — ${MISSION}\n\n| Phase | Status |\n|-------|--------|\n${failed.map((c) => `| ch${String(c).padStart(2, "0")} | queued |`).join("\n")}\n`,
  "utf8",
);

const queuePath = path.join(workbench, "queue", "now.yaml");
const yaml = `now:\n${now
  .map(
    (i) =>
      `  - id: ${i.id}\n    horizon: mission\n    kind: ${i.kind}\n    run_kind: ${i.run_kind}\n    repo_target: workbench\n    prompt: ${i.prompt}\n    provider: cursor_composer\n    max_minutes: ${i.max_minutes}\n    mission_id: ${i.mission_id}\n    phase_id: ${i.phase_id}\n    success_criteria: "${i.success_criteria.replace(/"/g, '\\"')}"`,
  )
  .join("\n")}\nbacklog: []\n`;
writeFileSync(queuePath, yaml, "utf8");
console.log(`[bootstrap] queued ${failed.length} chapter REVISE cycles → ${queuePath}`);
