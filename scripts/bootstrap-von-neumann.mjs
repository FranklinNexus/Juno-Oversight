#!/usr/bin/env node
/** Bootstrap juno-von-neumann-unit-2026 meta-mission + default evolution config. */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const MISSION = "juno-von-neumann-unit-2026";

const missionDir = path.join(workbench, "missions", MISSION);
const templateDir = path.join(repoRoot, "missions-templates", MISSION);
mkdirSync(missionDir, { recursive: true });

for (const name of ["north-star.md", "scope-lock.md", "progress.md"]) {
  const src = path.join(templateDir, name);
  const dest = path.join(missionDir, name);
  if (existsSync(src)) copyFileSync(src, dest);
}

for (const [example, dest] of [
  ["evolution-unit.example.json", "evolution-unit.json"],
  ["model-defaults.example.json", "model-defaults.json"],
]) {
  const src = path.join(repoRoot, "config", example);
  const out = path.join(workbench, "config", dest);
  mkdirSync(path.dirname(out), { recursive: true });
  if (!existsSync(out) && existsSync(src)) copyFileSync(src, out);
}

writeFileSync(
  path.join(missionDir, "status.md"),
  `# Von Neumann Unit — ${MISSION}\n\nSTATUS: RUNNING\n\nUpdated: ${new Date().toISOString()}\n`,
  "utf8",
);

console.log(`[bootstrap] ${MISSION} + config/evolution-unit.json ready`);
