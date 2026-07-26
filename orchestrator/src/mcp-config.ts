/**
 * Workbench MCP registry — scoped capability hints merged into spawn prompts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface McpServerEntry {
  id: string;
  /** MCP server name or descriptor. */
  server?: string;
  enabled?: boolean;
  /** When true, only attach for juno-overseer repo runs (dev branch) */
  devOnly?: boolean;
  /** Mission id allowlist; empty = all */
  missions?: string[];
  notes?: string;
}

export interface McpConfig {
  servers: McpServerEntry[];
  /** Default server ids suggested to live agent slots. */
  defaultForAgents?: string[];
  /** Deprecated config key retained only for Workbench migration. */
  defaultForComposer?: string[];
}

export interface McpRuntimeHints {
  enabledServers: McpServerEntry[];
  promptBlock: string;
  updatedAt: string;
}

function configPath(workbench: string): string {
  return path.join(workbench, "config", "mcp-servers.json");
}

function hintsPath(workbench: string): string {
  return path.join(workbench, "state", "mcp-hints.json");
}

export function loadMcpConfig(workbench: string): McpConfig {
  const p = configPath(workbench);
  if (!existsSync(p)) return { servers: [], defaultForAgents: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<McpConfig>;
    return {
      servers: raw.servers ?? [],
      defaultForAgents: raw.defaultForAgents ?? raw.defaultForComposer ?? [],
    };
  } catch {
    return { servers: [], defaultForAgents: [] };
  }
}

export function resolveMcpForRun(
  workbench: string,
  opts: { missionId?: string; repoRoot?: string; provider?: string },
): McpServerEntry[] {
  const cfg = loadMcpConfig(workbench);
  const defaults = new Set(cfg.defaultForAgents ?? []);
  const isDevRepo = opts.repoRoot === "juno-overseer";

  return cfg.servers.filter((s) => {
    if (s.enabled === false) return false;
    if (s.devOnly && !isDevRepo) return false;
    if (s.missions?.length && (!opts.missionId || !s.missions.includes(opts.missionId))) {
      return false;
    }
    if (defaults.has(s.id)) return true;
    return s.enabled === true;
  });
}

export function buildMcpPromptBlock(servers: McpServerEntry[]): string {
  if (servers.length === 0) {
    return "（Workbench 未提供 MCP capability hint；只使用当前 Codex 会话真实暴露的工具。）";
  }
  const lines = servers.map(
    (s) =>
      `- **${s.id}**${s.server ? ` → \`${s.server}\`` : ""}${s.notes ? ` — ${s.notes}` : ""}`,
  );
  return [
    "Workbench 建议以下 MCP；仅在当前 Codex 会话确实暴露同名 server 时使用：",
    ...lines,
    "",
    "不得假定 hint 等于已挂载能力；所有操作仍受 sandbox、scope-lock 与 safety verify 约束。",
  ].join("\n");
}

export function writeMcpHints(
  workbench: string,
  opts: { missionId?: string; repoRoot?: string; provider?: string },
): McpRuntimeHints {
  const enabledServers = resolveMcpForRun(workbench, opts);
  const hints: McpRuntimeHints = {
    enabledServers,
    promptBlock: buildMcpPromptBlock(enabledServers),
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(hintsPath(workbench)), { recursive: true });
  writeFileSync(hintsPath(workbench), `${JSON.stringify(hints, null, 2)}\n`, "utf8");
  return hints;
}

export function readMcpHints(workbench: string): McpRuntimeHints | null {
  const p = hintsPath(workbench);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as McpRuntimeHints;
  } catch {
    return null;
  }
}
