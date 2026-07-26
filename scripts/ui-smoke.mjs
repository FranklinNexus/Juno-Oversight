#!/usr/bin/env node
/**
 * UI smoke — GET dev server root; reject known Next/Turbopack error strings.
 * Usage: node scripts/ui-smoke.mjs
 * Env: JUNO_DEV_URL (default http://localhost:3000)
 */
const DEFAULT_URL = "http://localhost:3000";
const FORBIDDEN = [
  "Internal Server Error",
  "Turbopack error",
  "Runtime Error",
  "Cannot find module",
  "[turbopack]_runtime.js",
];

const base = (process.env.JUNO_DEV_URL ?? DEFAULT_URL).replace(/\/$/, "");
const url = `${base}/`;

async function main() {
  process.stderr.write(`[ui-smoke] GET ${url}\n`);
  let res;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ui-smoke] FAIL: fetch — ${msg}\n`);
    process.exit(1);
  }

  if (res.status !== 200) {
    process.stderr.write(`[ui-smoke] FAIL: HTTP ${res.status}\n`);
    process.exit(1);
  }

  const body = await res.text();
  for (const needle of FORBIDDEN) {
    if (body.includes(needle)) {
      process.stderr.write(`[ui-smoke] FAIL: body contains "${needle}"\n`);
      process.exit(1);
    }
  }

  process.stderr.write("[ui-smoke] PASS\n");
}

main();
