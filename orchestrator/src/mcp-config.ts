/**
 * Workbench MCP registry — merged into spawn prompts; hooks enforce vault gate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface McpServerEntry {
  id: string;
  /** Cursor MCP server name or descriptor */
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
  /** Default enabled server ids for cursor_composer live slots */
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
  if (!existsSync(p)) return { servers: [], defaultForComposer: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<McpConfig>;
    return { servers: raw.servers ?? [], defaultForComposer: raw.defaultForComposer ?? [] };
  } catch {
    return { servers: [], defaultForComposer: [] };
  }
}

export function resolveMcpForRun(
  workbench: string,
  opts: { missionId?: string; repoRoot?: string; provider?: string },
): McpServerEntry[] {
  const cfg = loadMcpConfig(workbench);
  const defaults = new Set(cfg.defaultForComposer ?? []);
  const isDevRepo = opts.repoRoot === "juno-overseer";

  return cfg.servers.filter((s) => {
    if (s.enabled === false) return false;
    if (s.devOnly && !isDevRepo) return false;
    if (s.missions?.length && opts.missionId && !s.missions.includes(opts.missionId)) {
      return false;
    }
    if (defaults.has(s.id)) return true;
    return s.enabled === true;
  });
}

export function buildMcpPromptBlock(servers: McpServerEntry[]): string {
  if (servers.length === 0) {
    return "（未配置 MCP — 仅使用 Cursor 内置工具与项目 hooks）";
  }
  const lines = servers.map(
    (s) =>
      `- **${s.id}**${s.server ? ` → \`${s.server}\`` : ""}${s.notes ? ` — ${s.notes}` : ""}`,
  );
  return [
    "以下 MCP 已在 Workbench 注册（dev 版自动挂载；Obsidian Vault 仍被 hook 拦截）：",
    ...lines,
    "",
    "优先用 MCP 做可验证操作（测试、API、文档查询），勿绕过 scope-lock。",
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
