#!/usr/bin/env node
/** Copy Juno .cursor hooks into AgentWorkbench so SDK runs inherit the same gates. */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const junoRoot = process.argv[2] ?? "C:\\Users\\kfr34\\Desktop\\Entrepreneurship\\Juno Oversight";
const workbench = process.argv[3] ?? process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

const srcHooks = path.join(junoRoot, ".cursor", "hooks");
const dstHooks = path.join(workbench, ".cursor", "hooks");
const srcJson = path.join(junoRoot, ".cursor", "hooks.json");
const dstJson = path.join(workbench, ".cursor", "hooks.json");

if (!existsSync(srcHooks)) {
  console.error("Missing", srcHooks);
  process.exit(1);
}

mkdirSync(path.join(workbench, ".cursor"), { recursive: true });
mkdirSync(dstHooks, { recursive: true });

for (const name of ["vault-gate.mjs", "destructive-ops-gate.mjs", "safety-gate-core.mjs"]) {
  cpSync(path.join(srcHooks, name), path.join(dstHooks, name));
}
cpSync(srcJson, dstJson);
console.log(`Synced hooks → ${dstJson}`);
