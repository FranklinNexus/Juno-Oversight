#!/usr/bin/env node
/**
 * Bootstrap juno-daily-autonomy-2026 — perpetual daily autonomy meta-mission.
 * Does NOT overwrite now.yaml (planner picks work when queue empty).
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const MISSION = "juno-daily-autonomy-2026";
const missionDir = path.join(workbench, "missions", MISSION);
const templateDir = path.join(repoRoot, "missions-templates", MISSION);

mkdirSync(missionDir, { recursive: true });

for (const name of ["north-star.md", "scope-lock.md", "progress.md"]) {
  const src = path.join(templateDir, name);
  const dest = path.join(missionDir, name);
  if (existsSync(src)) copyFileSync(src, dest);
}

const stamp = `# Daily Autonomy — ${MISSION}

STATUS: RUNNING

- daemon: \`pnpm juno:daemon\` — cap 满后等待 0 点续跑
- schedule: \`pnpm daily:juno:install\` — 0:00 备份批处理
- planner: queue 空时自决策下一 mission

Updated: ${new Date().toISOString()}
`;
writeFileSync(path.join(missionDir, "status.md"), stamp, "utf8");

console.log(`[bootstrap] ${MISSION} ready — start: pnpm juno:daemon`);
