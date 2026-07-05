#!/usr/bin/env node
/**
 * Bootstrap juno-wisdomechoes-axiom-blog-2026 — merge AI blog posts + chunked reader.
 * Usage: node scripts/bootstrap-wisdomechoes-blog.mjs [--force-queue]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const MISSION = "juno-wisdomechoes-axiom-blog-2026";
const missionDir = path.join(workbench, "missions", MISSION);
const templateDir = path.join(repoRoot, "missions-templates", MISSION);

mkdirSync(missionDir, { recursive: true });

for (const name of ["north-star.md", "scope-lock.md", "progress.md"]) {
  const src = path.join(templateDir, name);
  const dest = path.join(missionDir, name);
  if (existsSync(src)) copyFileSync(src, dest);
}

const phases = [
  [
    "w01-delete-recap-post",
    "implement",
    "Delete content/posts/juno-min-agi-loop.mdx; fix blog list/adjacent links; no 404 to deleted slug",
  ],
  [
    "w02-import-quality-book",
    "implement",
    "Update import-axiom-book.mjs single-post mode; import 全书.md from juno-axiom-book-2026 (quality PASS)",
  ],
  [
    "w03-juno-intro",
    "implement",
    "Write new Juno project intro (Runtime/Oversight/GitHub) at top of growing-from-axioms-full.mdx — not old recap",
  ],
  [
    "w04-chunked-reader",
    "implement",
    "LongBookReader: split by chapter, mount one chapter; wire growing-from-axioms-full in [slug]/page.tsx",
  ],
  [
    "w05-verify-build",
    "verify",
    "pnpm build WisdomEchoes.net PASS; VERIFY_REPORT page loads without freeze; chapter nav works",
  ],
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
      "    max_minutes: 60",
      `    success_criteria: "${criteria}"`,
    ].join("\n"),
  ),
  "backlog:",
  "  - id: juno-i01-implement-core",
  "    horizon: mission",
  "    kind: implement",
  "    run_kind: implement",
  "    repo_target: juno-overseer",
  "    mission_id: juno-daily-inbox-2026",
  "    phase_id: i01-implement-core",
  "    prompt: executor_implement",
  "    provider: cursor_composer",
  "    max_minutes: 45",
  '    success_criteria: "daily-inbox deferred — see juno-daily-inbox-2026"',
  "",
];

const queuePath = path.join(workbench, "queue", "now.yaml");
const forceQueue = process.argv.includes("--force-queue");

if (existsSync(queuePath) && !forceQueue) {
  const existing = readFileSync(queuePath, "utf8");
  if (/now:\s*\n\s+-/.test(existing) && !/mission_id:\s*juno-wisdomechoes-axiom-blog-2026/.test(existing)) {
    console.log(
      "[bootstrap:wisdomechoes] queue busy — scaffold only (use --force-queue to replace now.yaml)",
    );
    process.exit(0);
  }
}

writeFileSync(queuePath, yamlLines.join("\n"), "utf8");
console.log(`[bootstrap:wisdomechoes] mission ${MISSION} + queue w01–w05 (daily-inbox → backlog) → ${missionDir}`);
