#!/usr/bin/env node
/** Bootstrap juno-hardware-mcp-2026 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const MISSION = "juno-hardware-mcp-2026";
const missionDir = path.join(workbench, "missions", MISSION);
const templateDir = path.join(repoRoot, "missions-templates", MISSION);

mkdirSync(missionDir, { recursive: true });
for (const name of ["north-star.md", "scope-lock.md", "progress.md"]) {
  const src = path.join(templateDir, name);
  if (existsSync(src)) copyFileSync(src, path.join(missionDir, name));
}

const phases = [
  ["h01-scan-ports", "verify", "List COM ports; VERIFY_REPORT in checkpoint"],
  ["h02-scaffold-mcp", "implement", "npm install mcp-servers/serial-boards; enable mcp-servers.json"],
  ["h03-board-probe", "verify", "Probe both dev boards via serial-boards MCP or CLI"],
  ["h04-review", "review", "REVIEW_VERDICT PASS — safe hardware scope"],
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
      `    prompt: executor_${kind === "implement" ? "implement" : kind === "review" ? "review" : "verify"}`,
      "    provider: cursor_composer",
      "    max_minutes: 60",
      `    success_criteria: "${criteria}"`,
    ].join("\n"),
  ),
  "backlog: []",
  "",
];

const queuePath = path.join(workbench, "queue", "now.yaml");
if (!process.argv.includes("--force-queue") && existsSync(queuePath)) {
  const ex = readFileSync(queuePath, "utf8");
  if (/now:\s*\n\s+-/.test(ex) && !/juno-hardware-mcp-2026/.test(ex)) {
    console.log("[bootstrap:hardware-mcp] queue busy");
    process.exit(0);
  }
}
writeFileSync(queuePath, yamlLines.join("\n"), "utf8");
console.log(`[bootstrap:hardware-mcp] ${MISSION} queued`);
