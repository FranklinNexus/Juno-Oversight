#!/usr/bin/env node
/**
 * Promote completed mission checkpoint into wiki/mission-patterns.md (skill library).
 * Usage: node scripts/promote-mission-wiki.mjs <mission_id>
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const missionId = process.argv[2];

if (!missionId) {
  console.error("Usage: node scripts/promote-mission-wiki.mjs <mission_id>");
  process.exit(1);
}

const cpPath = path.join(workbench, "missions", missionId, "checkpoint.md");
if (!existsSync(cpPath)) {
  console.error(`Missing checkpoint: ${cpPath}`);
  process.exit(1);
}

const cp = readFileSync(cpPath, "utf8");
if (!/STATUS:\s*COMPLETE/i.test(cp)) {
  console.error(`Mission ${missionId} not COMPLETE — skip promote`);
  process.exit(1);
}

const wikiPath = path.join(repoRoot, "wiki", "mission-patterns.md");
const header = "# Mission 模式库（Skill Wiki）\n\n由 `pnpm promote:mission-wiki` 从 COMPLETE mission 追加。\n\n---\n\n";
const stamp = new Date().toISOString().slice(0, 10);
const entry = `\n## ${missionId} (${stamp})\n\n${cp.trim()}\n\n---\n`;

let body = "";
if (existsSync(wikiPath)) {
  body = readFileSync(wikiPath, "utf8");
  if (body.includes(`## ${missionId} (`)) {
    console.log(`Already promoted: ${missionId}`);
    process.exit(0);
  }
} else {
  body = header;
}

mkdirSync(path.dirname(wikiPath), { recursive: true });
writeFileSync(wikiPath, body + entry, "utf8");
console.log(`Promoted ${missionId} → ${wikiPath}`);
