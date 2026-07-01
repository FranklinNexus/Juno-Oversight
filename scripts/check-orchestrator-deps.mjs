#!/usr/bin/env node
/** Fail fast if orchestrator symlinks parent — breaks Next/Turbopack dev. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const orchDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "orchestrator");

function assertNoFileParent(spec, label) {
  if (typeof spec === "string" && /^file:\.\./.test(spec)) {
    console.error(`[juno] ${label} must not use ${spec} (Turbopack symlink loop)`);
    process.exit(1);
  }
}

const pkg = JSON.parse(readFileSync(path.join(orchDir, "package.json"), "utf8"));
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  assertNoFileParent(spec, `orchestrator/package.json ${name}`);
}

const lockPath = path.join(orchDir, "package-lock.json");
try {
  const lockText = readFileSync(lockPath, "utf8");
  if (/\"juno-hud\"\s*:\s*\"file:\.\./.test(lockText)) {
    console.error("[juno] orchestrator/package-lock.json still pins juno-hud: file:.. — run npm uninstall juno-hud");
    process.exit(1);
  }
} catch {
  // optional lockfile
}

console.error("[juno] orchestrator deps OK (no parent symlink)");
