/**
 * MCP discovery + scaffold when registry lacks needed effector (e.g. serial dev boards).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadMcpConfig, type McpServerEntry } from "./mcp-config.js";

export interface McpNeed {
  id: string;
  reason: string;
  transport?: "stdio" | "sse";
}

export interface McpScaffoldResult {
  created: boolean;
  serverId: string;
  serverPath?: string;
  registered: boolean;
  notes: string[];
}

const KNOWN_BUILTIN = new Set([
  "github",
  "cursor-browser",
  "cursor-ide-browser",
  "filesystem",
  "fetch",
  "postgres",
  "sqlite",
]);

export function detectMcpNeeds(briefText: string): McpNeed[] {
  const needs: McpNeed[] = [];
  const t = briefText.toLowerCase();
  if (/开发板|两块|serial|esp32|stm32|arduino|usb.?serial|gpio|硬件|dev.?board/.test(t)) {
    needs.push({
      id: "serial-boards",
      reason: "User brief mentions external dev boards / serial hardware",
      transport: "stdio",
    });
  }
  if (/\bmcp\b/i.test(briefText) && /自己写|scaffold|没有就/.test(briefText)) {
    needs.push({ id: "custom-effector", reason: "Brief requests custom MCP authoring", transport: "stdio" });
  }
  return needs;
}

export function findExistingMcp(workbench: string, needId: string): McpServerEntry | null {
  const cfg = loadMcpConfig(workbench);
  const hit = cfg.servers.find(
    (s) => s.id === needId || s.id.includes(needId) || (s.notes ?? "").toLowerCase().includes(needId),
  );
  return hit ?? null;
}

export function listWindowsComPorts(): string[] {
  if (process.platform !== "win32") return [];
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", "[System.IO.Ports.SerialPort]::GetPortNames() -join ','"],
    { encoding: "utf8", shell: false },
  );
  if (r.status !== 0) return [];
  return (r.stdout ?? "")
    .trim()
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export function scaffoldSerialBoardsMcp(
  junoRepoRoot: string,
  workbench: string,
): McpScaffoldResult {
  const serverId = "serial-boards";
  const existing = findExistingMcp(workbench, serverId);
  if (existing) {
    return { created: false, serverId, registered: true, notes: ["MCP already in registry"] };
  }

  const serverDir = path.join(junoRepoRoot, "mcp-servers", "serial-boards");
  mkdirSync(serverDir, { recursive: true });

  const indexTs = `#!/usr/bin/env node
/** MCP stdio server — list COM ports + raw serial write/read (dev boards). */
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";

const tools = [
  { name: "list_ports", description: "List available serial/COM ports" },
  { name: "serial_write", description: "Write line to port (path, data, baud=115200)" },
  { name: "serial_read", description: "Read lines for ms (path, timeoutMs=1000, baud=115200)" },
];

async function handleTool(name: string, args: Record<string, unknown>) {
  if (name === "list_ports") {
    const ports = await SerialPort.list();
    return { ports: ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer })) };
  }
  const portPath = String(args.path ?? "");
  const baud = Number(args.baud ?? 115200);
  if (!portPath) throw new Error("path required");
  if (name === "serial_write") {
    const data = String(args.data ?? "") + "\\n";
    await new Promise<void>((resolve, reject) => {
      const port = new SerialPort({ path: portPath, baudRate: baud, autoOpen: false });
      port.open((err) => {
        if (err) return reject(err);
        port.write(data, (e) => {
          port.close();
          e ? reject(e) : resolve();
        });
      });
    });
    return { ok: true };
  }
  if (name === "serial_read") {
    const timeoutMs = Number(args.timeoutMs ?? 1000);
    const lines: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const port = new SerialPort({ path: portPath, baudRate: baud, autoOpen: false });
      port.open((err) => {
        if (err) return reject(err);
        const parser = port.pipe(new ReadlineParser({ delimiter: "\\n" }));
        parser.on("data", (line: string) => lines.push(line));
        setTimeout(() => {
          port.close();
          resolve();
        }, timeoutMs);
      });
    });
    return { lines };
  }
  throw new Error("unknown tool: " + name);
}

// Minimal JSON-RPC loop for Cursor MCP stdio (implement slot may replace with @modelcontextprotocol/sdk)
process.stdin.on("data", async (chunk) => {
  try {
    const msg = JSON.parse(chunk.toString());
    if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ tools }) + "\\n");
    } else if (msg.method === "tools/call") {
      const result = await handleTool(msg.params?.name, msg.params?.arguments ?? {});
      process.stdout.write(JSON.stringify({ result }) + "\\n");
    }
  } catch (e) {
    process.stderr.write(String(e) + "\\n");
  }
});
`;

  writeFileSync(path.join(serverDir, "index.mjs"), indexTs, "utf8");
  writeFileSync(
    path.join(serverDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@juno/mcp-serial-boards",
        private: true,
        type: "module",
        dependencies: { serialport: "^12.0.0", "@serialport/parser-readline": "^12.0.0" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(serverDir, "README.md"),
    "# serial-boards MCP\n\nScaffold for USB serial dev boards. Run `npm install` in this folder.\n\nRegister in Workbench `config/mcp-servers.json`.\n",
    "utf8",
  );

  const cfgPath = path.join(workbench, "config", "mcp-servers.json");
  let cfg = loadMcpConfig(workbench);
  const entry: McpServerEntry = {
    id: serverId,
    server: path.join(serverDir, "index.mjs"),
    enabled: true,
    devOnly: false,
    missions: ["juno-hardware-mcp-2026"],
    notes: `Serial/COM — detected ports: ${listWindowsComPorts().join(", ") || "none"}`,
  };
  cfg = { ...cfg, servers: [...cfg.servers.filter((s) => s.id !== serverId), entry] };
  mkdirSync(path.dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

  const ports = listWindowsComPorts();
  return {
    created: true,
    serverId,
    serverPath: serverDir,
    registered: true,
    notes: [
      "Scaffold mcp-servers/serial-boards",
      `COM ports: ${ports.join(", ") || "scan at runtime"}`,
      "implement slot: npm install + wire @modelcontextprotocol/sdk if needed",
    ],
  };
}

export function provisionMcpForBrief(
  junoRepoRoot: string,
  workbench: string,
  briefText: string,
): McpScaffoldResult[] {
  const needs = detectMcpNeeds(briefText);
  const results: McpScaffoldResult[] = [];
  for (const need of needs) {
    if (KNOWN_BUILTIN.has(need.id)) {
      results.push({
        created: false,
        serverId: need.id,
        registered: true,
        notes: ["Use built-in/registry MCP"],
      });
      continue;
    }
    const existing = findExistingMcp(workbench, need.id);
    if (existing) {
      results.push({
        created: false,
        serverId: need.id,
        registered: true,
        notes: [`Existing: ${existing.id}`],
      });
      continue;
    }
    if (need.id === "serial-boards" || need.id === "custom-effector") {
      results.push(scaffoldSerialBoardsMcp(junoRepoRoot, workbench));
    }
  }
  return results;
}
