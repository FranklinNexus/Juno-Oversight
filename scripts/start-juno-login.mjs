#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const runtimeRoot = path.resolve(path.dirname(scriptPath), "..");
const DEFAULT_WORKBENCH_ROOT = "E:\\AgentWorkbench";

export function supportsJunoNode(version = process.version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

export function parseLoginStartupArgs(argv = []) {
  const configRoots = argv
    .filter((arg) => arg.startsWith("--config-root="))
    .map((arg) => arg.slice("--config-root=".length));
  const validateOnlyCount = argv.filter((arg) => arg === "--validate-only").length;
  const known = argv.filter(
    (arg) => arg === "--validate-only" || arg.startsWith("--config-root="),
  );
  if (known.length !== argv.length) throw new Error("unknown Juno login startup argument");
  if (configRoots.length > 1) throw new Error("--config-root may only be provided once");
  if (validateOnlyCount > 1) throw new Error("--validate-only may only be provided once");
  const configRoot = path.resolve(configRoots[0] || runtimeRoot);
  return { configRoot, validateOnly: validateOnlyCount === 1 };
}

function dotenvWorkbenchRoot(configRoot, name) {
  const target = path.join(configRoot, name);
  if (!existsSync(target)) return null;
  const parsed = parseEnv(readFileSync(target, "utf8"));
  const value = parsed.AGENT_WORKBENCH_ROOT?.trim();
  return value || null;
}

export function resolveLoginWorkbenchRoot(configRoot, environment = process.env) {
  const explicit = environment.AGENT_WORKBENCH_ROOT?.trim();
  return (
    explicit
    || dotenvWorkbenchRoot(configRoot, ".env.local")
    || dotenvWorkbenchRoot(configRoot, ".env")
    || DEFAULT_WORKBENCH_ROOT
  );
}

export async function runLoginStartup(argv = process.argv.slice(2)) {
  if (process.platform !== "win32") {
    throw new Error("Juno login startup is supported only on Windows");
  }
  if (!supportsJunoNode()) {
    throw new Error(`Node ${process.version} is too old; Juno requires >=22.13.0`);
  }
  const { configRoot, validateOnly } = parseLoginStartupArgs(argv);
  const workbenchRoot = resolveLoginWorkbenchRoot(configRoot);
  if (!path.isAbsolute(workbenchRoot)) {
    throw new Error("AGENT_WORKBENCH_ROOT must be an absolute path for login startup");
  }

  process.env.AGENT_WORKBENCH_ROOT = path.resolve(workbenchRoot);
  process.env.JUNO_OVERSIGHT_ROOT = runtimeRoot;
  process.env.JUNO_PACKAGED_RUNTIME = "1";

  const { validatePackagedRuntime } = await import("./lib/pnpm-runner.mjs");
  validatePackagedRuntime(runtimeRoot);
  if (validateOnly) {
    process.stdout.write(
      `[juno-login] runtime verified; Workbench=${process.env.AGENT_WORKBENCH_ROOT}\n`,
    );
    return;
  }

  const { runJunoDaemon } = await import("./run-juno-daemon.mjs");
  await runJunoDaemon([]);
}

function isMainModule() {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath));
}

if (isMainModule()) {
  try {
    await runLoginStartup();
  } catch (error) {
    process.stderr.write(
      `[juno-login] startup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
