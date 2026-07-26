#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const expected = String(pkg.packageManager ?? "").match(/^pnpm@([^+]+)/)?.[1];
const agent = process.env.npm_config_user_agent ?? "";
const actual = agent.match(/pnpm\/([^\s]+)/)?.[1];

if (!expected) {
  console.error("[package-manager] packageManager must pin pnpm");
  process.exit(1);
}

if (!actual) {
  console.error(
    `[package-manager] use Corepack pnpm ${expected}; current user agent: ${agent || "unknown"}`,
  );
  process.exit(1);
}

if (actual !== expected) {
  console.error(`[package-manager] expected pnpm ${expected}, got ${actual}`);
  process.exit(1);
}

console.log(`[package-manager] pnpm ${actual}`);
