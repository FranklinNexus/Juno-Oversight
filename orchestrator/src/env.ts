import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function junoProjectRoot(): string {
  if (process.env.JUNO_OVERSIGHT_ROOT?.trim()) {
    return process.env.JUNO_OVERSIGHT_ROOT.trim();
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

export function workbenchRoot(): string {
  return process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
}

export function loadProjectEnv(): void {
  const root = junoProjectRoot();
  for (const name of [".env.local", ".env"]) {
    const file = path.join(root, name);
    try {
      const text = readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = value;
      }
    } catch {
      // optional
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
