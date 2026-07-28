import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function parseEnvText(text) {
  const values = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function loadProjectEnv(repoRoot, options = {}) {
  const loaded = [];
  const override = options.override === true;
  for (const name of [".env.local", ".env"]) {
    const file = path.join(repoRoot, name);
    if (!existsSync(file)) continue;
    const values = parseEnvText(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (override || !process.env[key]) process.env[key] = value;
    }
    loaded.push(file);
  }
  return loaded;
}

export function defaultWorkbenchRoot() {
  return process.env.AGENT_WORKBENCH_ROOT?.trim() || path.join(os.homedir(), "JunoWorkbench");
}

function quoteEnvValue(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

export function updateEnvFile(file, updates) {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const remaining = new Map(Object.entries(updates));
  const lines = existing ? existing.split(/\r?\n/) : [];
  const next = [];

  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !remaining.has(match[1])) {
      next.push(line);
      continue;
    }
    next.push(`${match[1]}=${quoteEnvValue(remaining.get(match[1]))}`);
    remaining.delete(match[1]);
  }

  if (next.length > 0 && next[next.length - 1] !== "") next.push("");
  for (const [key, value] of remaining) next.push(`${key}=${quoteEnvValue(value)}`);
  if (!existing && !Object.hasOwn(updates, "CURSOR_API_KEY")) next.push("CURSOR_API_KEY=");
  writeFileSync(file, `${next.filter((line, index) => line || index < next.length - 1).join("\n")}\n`, "utf8");
}
