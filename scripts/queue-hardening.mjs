#!/usr/bin/env node
/**
 * Restore juno-overseer-hardening queue (h07–h11) when now.yaml was cleared.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const MISSION = "juno-overseer-hardening-2026";

const phases = [
  ["h07-promote-preview", "implement", "Promote diff preview UI/log"],
  ["h08-review-promote", "review", "REVIEW_VERDICT on promote preview"],
  ["h09-verify-all", "verify", "test+lint+cargo VERIFY_REPORT"],
  ["h10-drift-audit", "review", "drift audit REVIEW_VERDICT"],
  ["h11-final", "review", "final mission REVIEW_VERDICT"],
];

const now = phases.map(([phase, kind, criteria]) => ({
  id: `juno-${phase.replace(/-/g, "-")}`,
  phase,
  kind,
  criteria,
}));

const yamlLines = [
  `updated: ${new Date().toISOString()}`,
  "now:",
  ...now.map((p) =>
    [
      `  - id: juno-${p.phase}`,
      "    horizon: mission",
      `    kind: ${p.kind}`,
      `    run_kind: ${p.kind}`,
      "    repo_target: juno-overseer",
      `    mission_id: ${MISSION}`,
      `    phase_id: ${p.phase}`,
      `    prompt: executor_${p.kind === "implement" ? "implement" : p.kind === "verify" ? "verify" : "review"}`,
      "    provider: cursor_composer",
      "    max_minutes: 25",
      `    success_criteria: "${p.criteria}"`,
    ].join("\n"),
  ),
  "backlog: []",
  "",
];

const queuePath = path.join(workbench, "queue", "now.yaml");
if (existsSync(queuePath)) {
  const existing = readFileSync(queuePath, "utf8");
  if (/mission_id:\s*juno-overseer-hardening/.test(existing) && /now:\s*\n\s+-/.test(existing)) {
    console.log("[queue:hardening] hardening queue already present");
    process.exit(0);
  }
}

writeFileSync(queuePath, yamlLines.join("\n"), "utf8");
console.log(`[queue:hardening] restored h07–h11 → ${queuePath}`);
