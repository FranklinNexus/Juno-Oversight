#!/usr/bin/env node
/**
 * Desktop verification gate — catches compile/runtime issues that unit tests miss.
 * Usage: node scripts/verify-desktop.mjs
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

function assertNoOrchestratorSymlinkLoop() {
  const pkgPath = path.join(root, "orchestrator", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = pkg.dependencies ?? {};
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec === "string" && (spec.startsWith("file:..") || spec === "..")) {
      throw new Error(
        `orchestrator must not depend on parent via file:.. (${name} → ${spec}); breaks Next/Turbopack`,
      );
    }
  }
  process.stderr.write("[verify] PASS: no orchestrator→parent symlink loop\n");
}

try {
  assertNoOrchestratorSymlinkLoop();
} catch (err) {
  process.stderr.write(`[verify] FAIL: ${err.message}\n`);
  process.exit(1);
}

run("pnpm test", "pnpm", ["test"]);
run("pnpm lint", "pnpm", ["lint"]);
run("pnpm build", "pnpm", ["build"]);
run("dev smoke (Turbopack)", "node", ["scripts/dev-smoke.mjs"]);
run("orchestrator:build", "pnpm", ["orchestrator:build"]);
run("cargo check", "cargo", ["check"], { cwd: path.join(root, "src-tauri") });

process.stderr.write("[verify] all desktop gates passed\n");
