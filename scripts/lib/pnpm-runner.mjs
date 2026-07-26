import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_TIMEOUT_MS, spawnWithTimeout } from "./specialized-loop-guard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let verifiedPackagedRoot = null;

export const PACKAGED_RUNTIME_REQUIRED_ASSETS = Object.freeze([
  "orchestrator/dist/spawn-run.js",
  "orchestrator/dist/manifest.js",
  "orchestrator/dist/codex-executor.js",
  "orchestrator/dist/verify-runner.js",
  "orchestrator/dist/execution-artifact.js",
  "orchestrator/dist/control-file.js",
  "orchestrator/dist/workflow-experiment.js",
  "orchestrator/dist/mission-completion.js",
  "orchestrator/dist/operator-recovery.js",
  "orchestrator/dist/operator-recovery-cli.js",
  "orchestrator/dist/queue-io.js",
  "orchestrator/dist/safety-verify.js",
  "orchestrator/dist/literature-verify.js",
  "orchestrator/dist/revision-lineage.js",
  "orchestrator/dist/run-slot-lock.js",
  "orchestrator/dist/bounded-autonomy.js",
  "orchestrator/dist/autonomy-lock.js",
  "orchestrator/dist/autonomy-day.js",
  "scripts/run-juno-daemon.mjs",
  "scripts/start-juno-login.mjs",
  "scripts/terminate-process-tree.ps1",
  "scripts/lib/daemon-control.mjs",
  "scripts/juno-autonomy-tick.mjs",
  "node_modules/@openai/codex-sdk/dist/index.js",
  "node_modules/yaml/dist/index.js",
]);

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function validatePackagedRuntime(
  runtimeRoot = process.env.JUNO_OVERSIGHT_ROOT ?? repoRoot,
) {
  const root = path.resolve(runtimeRoot);
  if (verifiedPackagedRoot === root) return root;
  const manifestPath = path.join(root, "runtime-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`packaged Juno runtime manifest is unavailable: ${manifestPath}`, {
      cause: error,
    });
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.assets)) {
    throw new Error(`packaged Juno runtime manifest is invalid: ${manifestPath}`);
  }
  const required = new Set(PACKAGED_RUNTIME_REQUIRED_ASSETS);
  const declared = new Set();
  let totalBytes = 0;
  for (const asset of manifest.assets) {
    if (
      !asset
      || typeof asset.path !== "string"
      || !Number.isSafeInteger(asset.bytes)
      || !/^[a-f0-9]{64}$/.test(asset.sha256)
    ) {
      throw new Error(`packaged Juno runtime manifest contains an invalid asset entry`);
    }
    if (declared.has(asset.path)) {
      throw new Error(`packaged Juno runtime manifest contains a duplicate asset: ${asset.path}`);
    }
    declared.add(asset.path);
    const target = path.resolve(root, ...asset.path.split("/"));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`packaged Juno runtime asset escapes its root: ${asset.path}`);
    }
    let stat;
    try {
      stat = lstatSync(target);
    } catch (error) {
      throw new Error(`packaged Juno runtime asset is missing: ${asset.path}`, { cause: error });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`packaged Juno runtime asset is not a regular file: ${asset.path}`);
    }
    if (stat.size !== asset.bytes || sha256File(target) !== asset.sha256) {
      throw new Error(`packaged Juno runtime asset failed integrity validation: ${asset.path}`);
    }
    required.delete(asset.path);
    totalBytes += stat.size;
  }
  if (required.size > 0) {
    throw new Error(`packaged Juno runtime is incomplete: ${[...required].join(", ")}`);
  }
  if (totalBytes !== manifest.totalBytes) {
    throw new Error(`packaged Juno runtime size does not match its manifest`);
  }
  const actual = new Set();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).replaceAll(path.sep, "/");
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        throw new Error(`packaged Juno runtime contains a symlink: ${relative}`);
      }
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile() && relative !== "runtime-manifest.json") actual.add(relative);
      else if (!stat.isFile()) {
        throw new Error(`packaged Juno runtime contains an unsupported entry: ${relative}`);
      }
    }
  };
  visit(root);
  const missing = [...declared].filter((asset) => !actual.has(asset));
  const extra = [...actual].filter((asset) => !declared.has(asset));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `packaged Juno runtime file set does not match its manifest (missing: ${missing.join(", ")}; extra: ${extra.join(", ")})`,
    );
  }
  verifiedPackagedRoot = root;
  return root;
}

function packagedBuildResult(args) {
  if (
    process.env.JUNO_PACKAGED_RUNTIME !== "1"
    || args.length !== 1
    || args[0] !== "orchestrator:build"
  ) {
    return null;
  }
  validatePackagedRuntime();
  return {
    pid: null,
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    error: null,
    timedOut: false,
    terminationConfirmed: true,
    packagedRuntime: true,
  };
}

export function resolvePnpmInvocation(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("pnpm arguments must be strings");
  }

  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /pnpm/i.test(path.basename(npmExecPath)) && existsSync(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }

  const nodeDir = path.dirname(process.execPath);
  const pnpmEntry = path.join(nodeDir, "node_modules", "corepack", "dist", "pnpm.js");
  if (existsSync(pnpmEntry)) {
    return { command: process.execPath, args: [pnpmEntry, ...args] };
  }

  const corepackEntry = path.join(nodeDir, "node_modules", "corepack", "dist", "corepack.js");
  if (existsSync(corepackEntry)) {
    return { command: process.execPath, args: [corepackEntry, "pnpm", ...args] };
  }

  if (process.platform === "win32") {
    throw new Error("Corepack JS entrypoint not found beside the active Node runtime");
  }
  return { command: "corepack", args: ["pnpm", ...args] };
}

export function spawnPnpmSync(args, options = {}) {
  const packaged = packagedBuildResult(args);
  if (packaged) return packaged;
  const invocation = resolvePnpmInvocation(args);
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    shell: false,
  });
}

export function spawnPnpmWithTimeout(args, options = {}, timeoutMs = BUILD_TIMEOUT_MS) {
  const packaged = packagedBuildResult(args);
  if (packaged) return Promise.resolve(packaged);
  const invocation = resolvePnpmInvocation(args);
  return spawnWithTimeout(invocation.command, invocation.args, options, timeoutMs);
}
