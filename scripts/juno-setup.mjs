#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeJuno } from "./lib/juno-setup-core.mjs";
import {
  defaultWorkbenchRoot,
  loadProjectEnv,
} from "./lib/project-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(repoRoot);
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

try {
  const workbench = path.resolve(option("--workbench") ?? defaultWorkbenchRoot());
  const envFile = option("--env-output");
  const result = initializeJuno({
    repoRoot,
    workbench,
    envFile: envFile ? path.resolve(envFile) : undefined,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
