#!/usr/bin/env node
/** Restore juno-agi-literature-2026 backlog → now. */
import { copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const missionId = "juno-agi-literature-2026";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const build = spawnSync("pnpm", ["orchestrator:build"], { cwd: repoRoot, stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const { promoteMissionFromBacklog } = await import("../orchestrator/dist/promote-queue.js");
const queuePath = path.join(workbench, "queue", "now.yaml");
const backup = path.join(workbench, "queue", `now.yaml.bak-restore-agi-${Date.now()}.yaml`);
copyFileSync(queuePath, backup);

const result = promoteMissionFromBacklog(workbench, missionId);
process.stderr.write(`[restore-agi] promoted ${result.promoted.length} (backup: ${backup})\n`);
if (result.promoted.length === 0) process.exit(1);
process.stderr.write(`[restore-agi] now head: ${result.now[0]?.id}\n`);
