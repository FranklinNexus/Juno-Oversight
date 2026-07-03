#!/usr/bin/env node
/**
 * Start next dev on a free port, GET /, fail on 500 or Turbopack error strings.
 * Catches stale-cache regressions that `next build` alone misses.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repairDevCache } from "./check-dev-cache.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.JUNO_DEV_SMOKE_PORT ?? 3099);
const URL = `http://127.0.0.1:${PORT}/`;
const FORBIDDEN = [
  "Internal Server Error",
  "Runtime Error",
  "Cannot find module",
  "Turbopack error",
  "[turbopack]_runtime.js",
];

function log(msg) {
  process.stderr.write(`[dev-smoke] ${msg}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

repairDevCache({ quiet: true });

const child = spawn("pnpm", ["exec", "next", "dev", "-p", String(PORT)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  shell: true,
  env: { ...process.env, FORCE_COLOR: "0" },
});

let ready = false;
const onData = (chunk) => {
  const text = chunk.toString();
  if (/Ready in/i.test(text)) ready = true;
};

child.stdout?.on("data", onData);
child.stderr?.on("data", onData);

function killDev() {
  if (!child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

process.on("SIGINT", () => {
  killDev();
  process.exit(130);
});

try {
  for (let i = 0; i < 60 && !ready; i += 1) {
    await sleep(500);
  }
  if (!ready) {
    log("FAIL: dev server did not become ready in 30s");
    killDev();
    process.exit(1);
  }

  log(`GET ${URL}`);
  const res = await fetch(URL, { redirect: "follow" });
  const body = await res.text();

  if (res.status !== 200) {
    log(`FAIL: HTTP ${res.status}`);
    killDev();
    process.exit(1);
  }

  for (const needle of FORBIDDEN) {
    if (body.includes(needle)) {
      log(`FAIL: body contains "${needle}"`);
      killDev();
      process.exit(1);
    }
  }

  log("PASS");
  killDev();
  await sleep(400);
  process.exit(0);
} catch (err) {
  log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  killDev();
  process.exit(1);
}
