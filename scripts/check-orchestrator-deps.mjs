#!/usr/bin/env node
/** Validate the single-lock pnpm workspace contract before build/install. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const orchDir = path.join(root, "orchestrator");

function fail(message) {
  console.error(`[workspace] ${message}`);
  process.exit(1);
}

function assertNoFileParent(spec, label) {
  if (typeof spec === "string" && /^file:\.\./.test(spec)) {
    fail(`${label} must not use ${spec} (Turbopack symlink loop)`);
  }
}

const pkg = JSON.parse(readFileSync(path.join(orchDir, "package.json"), "utf8"));
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  assertNoFileParent(spec, `orchestrator/package.json ${name}`);
}

const workspaceText = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
const packageBlock = workspaceText.match(/^packages:\s*\r?\n((?:\s{2}-[^\r\n]+\r?\n?)+)/m)?.[1] ?? "";
const workspacePackages = packageBlock
  .split(/\r?\n/)
  .map((line) => line.replace(/^\s*-\s*/, "").replace(/^['\"]|['\"]$/g, "").trim())
  .filter(Boolean);
if (!workspacePackages.includes("orchestrator")) {
  fail("pnpm-workspace.yaml must include orchestrator");
}

const pnpmLockPath = path.join(root, "pnpm-lock.yaml");
const pnpmLock = readFileSync(pnpmLockPath, "utf8");
if (!/^  orchestrator:\s*$/m.test(pnpmLock)) {
  fail("pnpm-lock.yaml is missing the orchestrator importer; run `corepack pnpm install`");
}
if (existsSync(path.join(orchDir, "package-lock.json"))) {
  fail("orchestrator/package-lock.json is obsolete; pnpm-lock.yaml is the only dependency lock");
}

console.error("[workspace] orchestrator dependency contract OK (pnpm single lock)");
