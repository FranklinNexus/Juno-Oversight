#!/usr/bin/env node
/** Background daemon for axiom book mission — respects API gateway backoff. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOOK_MISSION_ID } from "./lib/book-decision.mjs";
import { countBookHan } from "./lib/book-decision.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const intervalMs = Number(process.argv.find((a) => a.startsWith("--interval-ms="))?.split("=")[1] ?? 120_000);

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

const pidPath = path.join(workbench, "state", "book-daemon.pid");
const statePath = path.join(workbench, "state", "book-daemon.json");
mkdirSync(path.join(workbench, "state"), { recursive: true });
writeFileSync(pidPath, String(process.pid), "utf8");

function log(m) {
  process.stderr.write(`[book-daemon] ${m}\n`);
}

function missionComplete() {
  const cp = path.join(workbench, "missions", BOOK_MISSION_ID, "checkpoint.md");
  return existsSync(cp) && /STATUS:\s*COMPLETE/i.test(readFileSync(cp, "utf8"));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadGateway() {
  spawnSync("pnpm", ["orchestrator:build"], { cwd: repoRoot, stdio: "pipe", shell: true });
  return import("../orchestrator/dist/api-gateway.js");
}

function backoffSleepMs(gateway) {
  const rows = gateway.getQuotaStatus(workbench);
  const cursor = rows.find((r) => r.providerId === "cursor");
  if (!cursor?.backoffUntil) return 0;
  const until = Date.parse(cursor.backoffUntil);
  if (Number.isNaN(until)) return 0;
  return Math.max(0, until - Date.now() + 2000);
}

log(`started pid=${process.pid} interval=${intervalMs}ms`);

const gateway = await loadGateway();

while (true) {
  if (missionComplete()) {
    writeFileSync(
      statePath,
      `${JSON.stringify({ status: "complete", bookHan: countBookHan(workbench), updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    log("mission COMPLETE — exit");
    break;
  }

  const backoffMs = backoffSleepMs(gateway);
  if (backoffMs > 0) {
    log(`API backoff — sleep ${Math.round(backoffMs / 1000)}s`);
    await sleep(backoffMs);
  }

  const tick = spawnSync("node", ["scripts/juno-autonomy-tick.mjs", "--execute"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });

  const quota = gateway.getQuotaStatus(workbench).find((r) => r.providerId === "cursor");
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        status: "running",
        lastExit: tick.status,
        bookHan: countBookHan(workbench),
        api: quota
          ? { rpm: quota.rpm, dailyRequests: quota.dailyRequests, backoffUntil: quota.backoffUntil }
          : null,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await sleep(intervalMs);
}

writeFileSync(pidPath, "", "utf8");
