#!/usr/bin/env node
/**
 * Submit natural-language brief → mission queue (+ optional MCP scaffold + auto-push config).
 *
 * Usage:
 *   pnpm juno:brief "把 wisdomechoes 两篇 AI 文合并…"
 *   pnpm juno:brief --file "E:/Obsidian Vault/Juno/inbox/brief.md"
 *   pnpm juno:brief --execute --file ...
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const fileArg = args.find((a) => a.startsWith("--file="))?.split("=")[1]
  ?? (args.includes("--file") ? args[args.indexOf("--file") + 1] : undefined);
const textParts = args.filter((a) => !a.startsWith("--"));

let text = textParts.join(" ").trim();
if (fileArg) {
  if (!existsSync(fileArg)) {
    console.error(`[juno:brief] file not found: ${fileArg}`);
    process.exit(1);
  }
  text = readFileSync(fileArg, "utf8").trim();
}

if (!text) {
  console.error(`Usage: pnpm juno:brief "your task" | --file path/to/brief.md [--execute]`);
  process.exit(1);
}

const build = await import("node:child_process").then(({ spawnSync }) =>
  spawnSync("pnpm", ["orchestrator:build"], { cwd: repoRoot, stdio: "inherit", shell: true }),
);
if (build.status !== 0) process.exit(build.status ?? 1);

const {
  compileBriefFromText,
  routeBriefToKnownMission,
  savePendingBrief,
  writeBriefMission,
  clearPendingBrief,
} = await import("../orchestrator/dist/mission-brief.js");
const { provisionMcpForBrief } = await import("../orchestrator/dist/mcp-provision.js");

savePendingBrief(workbench, { text, submittedAt: new Date().toISOString(), source: fileArg ?? "cli" });

const known = routeBriefToKnownMission(text);
if (known) {
  console.log(JSON.stringify({ action: "route_known", missionId: known, text: text.slice(0, 120) }, null, 2));
  if (execute) {
    const { spawnSync } = await import("node:child_process");
    const boot =
      known === "juno-wisdomechoes-axiom-blog-2026"
        ? "bootstrap-wisdomechoes-blog.mjs"
        : known === "juno-daily-inbox-2026"
          ? "bootstrap-daily-inbox.mjs"
          : known === "juno-hardware-mcp-2026"
            ? "bootstrap-hardware-mcp.mjs"
            : known === "juno-nl-brief-2026"
              ? "bootstrap-nl-brief.mjs"
              : null;
    if (boot) {
      spawnSync("node", [`scripts/${boot}`, "--force-queue"], { cwd: repoRoot, stdio: "inherit" });
    }
  }
  clearPendingBrief(workbench);
  process.exit(0);
}

const plan = compileBriefFromText(text);
console.log(JSON.stringify({ action: "compile", plan: { ...plan, northStar: undefined, scopeLock: undefined } }, null, 2));

if (plan.needsMcp) {
  const mcp = provisionMcpForBrief(repoRoot, workbench, text);
  console.log(JSON.stringify({ mcp }, null, 2));
}

if (!execute) {
  console.error("\n[dry-run] pass --execute to write mission + queue");
  process.exit(0);
}

const missionDir = writeBriefMission(workbench, plan);
clearPendingBrief(workbench);
console.error(`[juno:brief] mission ${plan.missionId} → ${missionDir}`);
console.error(`[juno:brief] schedule=${plan.schedule} autoPush=${plan.autoPush} — run: pnpm juno:autonomy:start`);
