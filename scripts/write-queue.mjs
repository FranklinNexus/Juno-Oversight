#!/usr/bin/env node
/** Write AgentWorkbench queue/now.yaml from JSON (avoids PowerShell YAML quoting bugs). */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function yamlQuote(value) {
  if (value == null || value === "") return '""';
  const s = String(value);
  if (/^[a-zA-Z0-9_./+-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatItem(item, indent = "  ") {
  const lines = [`${indent}- id: ${yamlQuote(item.id)}`];
  const fields = [
    "horizon",
    "kind",
    "run_kind",
    "repo_target",
    "mission_id",
    "phase_id",
    "prompt",
    "provider",
    "max_minutes",
    "success_criteria",
  ];
  for (const key of fields) {
    if (item[key] == null) continue;
    if (key === "max_minutes") {
      lines.push(`${indent}  ${key}: ${Number(item[key])}`);
    } else {
      lines.push(`${indent}  ${key}: ${yamlQuote(item[key])}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function writeQueue(outPath, payload) {
  const { updated, now = [], backlog = [] } = payload;
  let yaml = `updated: ${yamlQuote(updated ?? new Date().toISOString())}\nnow:\n`;
  for (const item of now) {
    yaml += formatItem(item);
  }
  yaml += "backlog:\n";
  if (backlog.length === 0) {
    yaml += "  []\n";
  } else {
    for (const item of backlog) {
      yaml += formatItem(item);
    }
  }
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, yaml, "utf8");
}

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const jsonIdx = args.indexOf("--json");
const outPath =
  outIdx >= 0 ? args[outIdx + 1] : path.join("E:", "AgentWorkbench", "queue", "now.yaml");
const jsonPath = jsonIdx >= 0 ? args[jsonIdx + 1] : null;

if (!jsonPath) {
  console.error("Usage: node write-queue.mjs --json queue.json [--out path/to/now.yaml]");
  process.exit(1);
}

const raw = readFileSync(jsonPath, "utf8").replace(/^\uFEFF/, "");
const payload = JSON.parse(raw);
writeQueue(outPath, payload);
console.error(
  `[juno] wrote ${outPath} (${payload.now?.length ?? 0} now, ${payload.backlog?.length ?? 0} backlog)`,
);
