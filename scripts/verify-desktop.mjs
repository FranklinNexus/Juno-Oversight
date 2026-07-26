#!/usr/bin/env node
/**
 * Desktop verification gate — catches compile/runtime issues that unit tests miss.
 * Usage: node scripts/verify-desktop.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(label, cmd, args, opts = {}) {
  process.stderr.write(`[verify] ${label}…\n`);
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (res.status !== 0) {
    process.stderr.write(`[verify] FAIL: ${label}\n`);
    process.exit(res.status ?? 1);
  }
  process.stderr.write(`[verify] PASS: ${label}\n`);
}

run("package manager", "pnpm", ["package-manager:check"]);
run("workspace dependency contract", "node", ["scripts/check-orchestrator-deps.mjs"]);
run("orchestrator:build", "pnpm", ["orchestrator:build"]);
run("pnpm test", "pnpm", ["test"]);
run("pnpm lint", "pnpm", ["lint"]);
run("pnpm build", "pnpm", ["build"]);
run("dev smoke (Turbopack)", "node", ["scripts/dev-smoke.mjs"]);
run("cargo check", "cargo", ["check"], { cwd: path.join(root, "src-tauri") });
run("cargo test", "cargo", ["test"], { cwd: path.join(root, "src-tauri") });

process.stderr.write("[verify] all desktop gates passed\n");
