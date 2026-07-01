#!/usr/bin/env node
/** Show API quota / rate-limit status. Usage: pnpm api:quota */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

spawnSync("pnpm", ["orchestrator:build"], { cwd: repoRoot, stdio: "inherit", shell: true });

const {
  getQuotaStatus,
  estimateMissionCapacity,
  loadApiLimits,
} = await import("../orchestrator/dist/api-gateway.js");

console.log("\n=== API Quota Status ===\n");
for (const row of getQuotaStatus(workbench)) {
  console.log(`[${row.providerId}]`);
  console.log(`  inflight: ${row.inflight}/${row.limits.maxConcurrent}`);
  console.log(`  rpm: ${row.rpm}/${row.limits.maxRpm}  rph: ${row.rph}/${row.limits.maxRph}`);
  console.log(`  daily: ${row.dailyRequests}/${row.limits.maxRpd} req, ${row.dailyTokens} tokens`);
  if (row.limits.tokenBudgetDaily > 0) {
    console.log(`  token budget: ${row.dailyTokens}/${row.limits.tokenBudgetDaily}`);
  }
  if (row.backoffUntil) console.log(`  backoff until: ${row.backoffUntil}`);
  console.log("");
}

const cfg = loadApiLimits(workbench);
for (const missionId of Object.keys(cfg.missions ?? {})) {
  const cap = estimateMissionCapacity(workbench, missionId);
  if (!cap) continue;
  console.log(`=== Mission capacity: ${missionId} ===`);
  console.log(`  live slots: ${cap.liveSlots}`);
  console.log(`  est tokens: ${cap.totalTokens.toLocaleString()} (~${cap.tokensPerSlot}/slot)`);
  console.log(`  est wall: ~${cap.estimatedWallHours.toFixed(1)} h (35 min/slot)`);
  console.log(`  cursor daily cap: ${cap.providers.cursor.dailyCapacityRequests} req\n`);
}
