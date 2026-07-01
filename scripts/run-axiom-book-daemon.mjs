#!/usr/bin/env node
/** Background daemon for axiom book mission. */
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

log(`started pid=${process.pid} interval=${intervalMs}ms`);

while (true) {
  if (missionComplete()) {
    writeFileSync(statePath, `${JSON.stringify({ status: "complete", bookHan: countBookHan(workbench), updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    log("mission COMPLETE — exit");
    break;
  }

  const tick = spawnSync("node", ["scripts/juno-autonomy-tick.mjs", "--execute"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });

  writeFileSync(
    statePath,
    `${JSON.stringify({ status: "running", lastExit: tick.status, bookHan: countBookHan(workbench), updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );

  await sleep(intervalMs);
}

writeFileSync(pidPath, "", "utf8");
