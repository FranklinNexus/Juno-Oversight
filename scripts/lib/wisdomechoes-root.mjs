#!/usr/bin/env node
/** Read wisdomechoes_root from AgentWorkbench config.yaml (no clone — local only). */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT = "C:/Users/kfr34/Desktop/Entrepreneurship/WisdomEchoes.net";

export function readWorkbenchYaml(workbench) {
  const cfg = path.join(workbench, "config.yaml");
  if (!existsSync(cfg)) return {};
  const text = readFileSync(cfg, "utf8");
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*["']?([^"'\n]+)/i);
    if (m) out[m[1]] = m[2].trim().replace(/\\\\/g, "\\");
  }
  return out;
}

export function resolveWisdomEchoesRoot(workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench") {
  if (process.env.WISDOMECHOES_ROOT?.trim()) {
    return path.resolve(process.env.WISDOMECHOES_ROOT.trim());
  }
  const wb = readWorkbenchYaml(workbench);
  return path.resolve(wb.wisdomechoes_root ?? DEFAULT);
}
