#!/usr/bin/env node
/** Compute evolution fitness + append log (no Live API). */
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const build = await import("node:child_process").then(({ spawnSync }) =>
  spawnSync("pnpm", ["orchestrator:build"], { cwd: repoRoot, stdio: "inherit", shell: true }),
);
if (build.status !== 0) process.exit(build.status ?? 1);

const { recordEvolutionTick } = await import("../orchestrator/dist/evolution-unit.js");
const snap = recordEvolutionTick(workbench, { trigger: "manual", note: "pnpm evolution:tick" });
console.log(JSON.stringify(snap, null, 2));
