#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const DEFAULT_REPO_ROOT = path.resolve(path.dirname(scriptPath), "..");
export const DEFAULT_RUNTIME_ROOT = path.join(
  DEFAULT_REPO_ROOT,
  "src-tauri",
  "resources",
  "juno-runtime",
);

const MAX_RUNTIME_BYTES = 20 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 5 * 1024 * 1024;
const SECRET_FILE = /^(?:\.env(?:\..*)?|credentials(?:\..*)?|id_rsa(?:\..*)?|.*\.(?:pem|p12|pfx|key))$/i;
const SECRET_CONTENT = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:OPENAI|CURSOR)_API_KEY\s*=\s*[^\s"'`$<{][^\s]*/,
];
export const RUNTIME_SCRIPT_FILES = new Set([
  "bootstrap-agi-literature.mjs",
  "bootstrap-axiom-book.mjs",
  "bootstrap-book-quality-revise.mjs",
  "bootstrap-workbench-cleanup.mjs",
  "juno-autonomy-tick.mjs",
  "lib/agi-advance-core.mjs",
  "lib/book-advance-core.mjs",
  "lib/book-decision.mjs",
  "lib/checkpoint-status.mjs",
  "lib/daemon-control.mjs",
  "lib/pnpm-runner.mjs",
  "lib/queue-bootstrap.mjs",
  "lib/specialized-loop-guard.mjs",
  "lib/workflow-selection-migration-args.mjs",
  "migrate-workflow-selection.mjs",
  "queue-hardening.mjs",
  "run-agi-literature-loop.mjs",
  "run-axiom-book-loop.mjs",
  "run-book-quality-loop.mjs",
  "run-evolution-tick.mjs",
  "run-juno-daemon.mjs",
  "run-mission-loop.mjs",
  "run-self-optimize.mjs",
  "start-juno-login.mjs",
  "terminate-process-tree.ps1",
  "run-workflow-experiment.mjs",
]);
export const RUNTIME_WIKI_FILES = new Set([
  "agent-literature-index.md",
  "juno-agent-architecture.md",
  "juno-agi-north-star.md",
  "overseer-quality.md",
]);
export const RUNTIME_TEMPLATE_FILES = new Set([
  "juno-workbench-cleanup-2026/north-star.md",
  "juno-workbench-cleanup-2026/progress.md",
  "juno-workbench-cleanup-2026/scope-lock.md",
]);
export const REQUIRED_RUNTIME_ASSETS = [
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
];

export function assertRuntimeSize(totalBytes) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_RUNTIME_BYTES) {
    throw new Error(`desktop runtime exceeds ${MAX_RUNTIME_BYTES} bytes: ${totalBytes}`);
  }
  return totalBytes;
}

function assertSafeOutput(repoRoot, outputRoot) {
  const resourcesRoot = path.resolve(repoRoot, "src-tauri", "resources");
  const resolved = path.resolve(outputRoot);
  const relative = path.relative(resourcesRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`desktop runtime output must be inside ${resourcesRoot}: ${resolved}`);
  }
  return resolved;
}

function assertSourceEntrySafe(sourcePath) {
  const stat = lstatSync(sourcePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`desktop runtime source must not contain symbolic links: ${sourcePath}`);
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`unsupported desktop runtime source entry: ${sourcePath}`);
  }
  if (stat.isFile()) {
    if (SECRET_FILE.test(path.basename(sourcePath))) {
      throw new Error(`refusing to package secret-like file: ${sourcePath}`);
    }
    if (stat.size > MAX_SINGLE_FILE_BYTES) {
      throw new Error(`desktop runtime file exceeds ${MAX_SINGLE_FILE_BYTES} bytes: ${sourcePath}`);
    }
  }
  return stat;
}

function copyTree(sourceRoot, targetRoot, include = () => true) {
  const sourceStat = assertSourceEntrySafe(sourceRoot);
  if (sourceStat.isFile()) {
    if (!include(sourceRoot)) return;
    mkdirSync(path.dirname(targetRoot), { recursive: true });
    copyFileSync(sourceRoot, targetRoot);
    return;
  }

  mkdirSync(targetRoot, { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = path.join(sourceRoot, entry.name);
    const target = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) copyTree(source, target, include);
    else if (include(source)) copyTree(source, target, include);
  }
}

function copyRequiredFile(source, target) {
  if (!existsSync(source)) throw new Error(`required desktop runtime asset is missing: ${source}`);
  copyTree(source, target);
}

function findPackageRoot(repoRoot, packageName) {
  const candidates = [
    path.join(repoRoot, "orchestrator", "node_modules", ...packageName.split("/")),
    path.join(repoRoot, "node_modules", ...packageName.split("/")),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const resolved = realpathSync.native(candidate);
    const packagePath = path.join(resolved, "package.json");
    if (existsSync(packagePath)) return resolved;
  }

  const requireFromOrchestrator = createRequire(path.join(repoRoot, "orchestrator", "package.json"));
  let entry;
  try {
    entry = requireFromOrchestrator.resolve(packageName);
  } catch (error) {
    throw new Error(
      `desktop runtime dependency ${packageName} is unavailable; run the frozen workspace install first`,
      { cause: error },
    );
  }
  let current = path.dirname(realpathSync.native(entry));
  while (path.dirname(current) !== current) {
    const packagePath = path.join(current, "package.json");
    if (existsSync(packagePath)) {
      const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
      if (metadata.name === packageName) return current;
    }
    current = path.dirname(current);
  }
  throw new Error(`could not locate package root for desktop dependency ${packageName}`);
}

function copyPackageFiles(repoRoot, outputRoot, packageName, include) {
  const source = findPackageRoot(repoRoot, packageName);
  const target = path.join(outputRoot, "node_modules", ...packageName.split("/"));
  copyTree(source, target, (file) => {
    const relative = path.relative(source, file).replaceAll(path.sep, "/");
    return include(relative);
  });
}

function runtimeScriptsPackage(repoRoot) {
  const source = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return {
    name: "juno-desktop-runtime",
    version: source.version,
    private: true,
    type: "module",
    engines: source.engines,
    packageManager: source.packageManager,
    scripts: {
      "autonomy:tick": "node scripts/juno-autonomy-tick.mjs",
      "agi:loop": "node scripts/run-agi-literature-loop.mjs",
      "book:loop": "node scripts/run-axiom-book-loop.mjs",
      "book:quality-loop": "node scripts/run-book-quality-loop.mjs",
      "evolution:tick": "node scripts/run-evolution-tick.mjs --skip-build",
      "evolution:canary": "node scripts/run-workflow-experiment.mjs --skip-build",
      "juno:daemon": "node scripts/run-juno-daemon.mjs",
      "mission:loop": "node scripts/run-mission-loop.mjs --skip-build",
      "queue:agi-literature": "node scripts/bootstrap-agi-literature.mjs",
      "queue:axiom-book": "node scripts/bootstrap-axiom-book.mjs",
      "queue:cleanup": "node scripts/bootstrap-workbench-cleanup.mjs",
      "queue:hardening": "node scripts/queue-hardening.mjs",
      "self:optimize": "node scripts/run-self-optimize.mjs",
      "workflow:selection:migrate": "node scripts/migrate-workflow-selection.mjs --skip-build",
    },
  };
}

function orchestratorRuntimePackage(repoRoot) {
  const source = JSON.parse(
    readFileSync(path.join(repoRoot, "orchestrator", "package.json"), "utf8"),
  );
  return {
    name: source.name,
    version: source.version,
    private: true,
    type: "module",
    engines: source.engines,
    dependencies: source.dependencies,
  };
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function listRuntimeAssets(runtimeRoot) {
  const assets = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(runtimeRoot, absolute).replaceAll(path.sep, "/");
      if (relative === "runtime-manifest.json") continue;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`staged runtime contains a symlink: ${relative}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        if (SECRET_FILE.test(entry.name)) {
          throw new Error(`staged runtime contains a secret-like file: ${relative}`);
        }
        if (stat.size > MAX_SINGLE_FILE_BYTES) {
          throw new Error(`staged runtime file is unexpectedly large: ${relative}`);
        }
        const content = readFileSync(absolute, "utf8");
        if (SECRET_CONTENT.some((pattern) => pattern.test(content))) {
          throw new Error(`staged runtime contains secret-like content: ${relative}`);
        }
        assets.push({ path: relative, bytes: stat.size, sha256: sha256File(absolute) });
      } else {
        throw new Error(`staged runtime contains an unsupported entry: ${relative}`);
      }
    }
  };
  visit(runtimeRoot);
  return assets.sort((left, right) => left.path.localeCompare(right.path));
}

export function validateStagedRuntime(runtimeRoot = DEFAULT_RUNTIME_ROOT) {
  const resolved = path.resolve(runtimeRoot);
  const manifestPath = path.join(resolved, "runtime-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`desktop runtime manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.assets)) {
    throw new Error(`desktop runtime manifest is invalid: ${manifestPath}`);
  }
  let totalBytes = 0;
  for (const asset of manifest.assets) {
    if (
      !asset
      || typeof asset.path !== "string"
      || !Number.isSafeInteger(asset.bytes)
      || !/^[a-f0-9]{64}$/.test(asset.sha256)
    ) {
      throw new Error(`desktop runtime manifest has an invalid asset entry: ${manifestPath}`);
    }
    const target = path.resolve(resolved, ...asset.path.split("/"));
    const relative = path.relative(resolved, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`desktop runtime manifest path escapes its root: ${asset.path}`);
    }
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`desktop runtime asset must be a regular file: ${asset.path}`);
    }
    if (stat.size !== asset.bytes || sha256File(target) !== asset.sha256) {
      throw new Error(`desktop runtime asset failed integrity verification: ${asset.path}`);
    }
    totalBytes += stat.size;
  }
  if (totalBytes !== manifest.totalBytes) {
    throw new Error(`desktop runtime size validation failed: ${totalBytes} bytes`);
  }
  assertRuntimeSize(totalBytes);
  for (const required of REQUIRED_RUNTIME_ASSETS) {
    if (!manifest.assets.some((asset) => asset.path === required)) {
      throw new Error(`desktop runtime is missing required asset: ${required}`);
    }
  }
  if (manifest.assets.some((asset) => /codex-(?:win32|linux|darwin)-/i.test(asset.path))) {
    throw new Error("desktop runtime must not embed the large Codex platform binary package");
  }
  const actualAssets = listRuntimeAssets(resolved);
  if (
    actualAssets.length !== manifest.assets.length
    || actualAssets.some((asset, index) =>
      asset.path !== manifest.assets[index].path
      || asset.bytes !== manifest.assets[index].bytes
      || asset.sha256 !== manifest.assets[index].sha256
    )
  ) {
    throw new Error("desktop runtime file set does not match its manifest");
  }
  return manifest;
}

export function stageDesktopRuntime({
  repoRoot = DEFAULT_REPO_ROOT,
  outputRoot = DEFAULT_RUNTIME_ROOT,
} = {}) {
  const root = path.resolve(repoRoot);
  const output = assertSafeOutput(root, outputRoot);
  const distRoot = path.join(root, "orchestrator", "dist");
  if (!existsSync(path.join(distRoot, "spawn-run.js"))) {
    throw new Error("orchestrator dist is missing; run the orchestrator build before staging desktop assets");
  }

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, ".gitkeep"), "", "utf8");
  copyTree(distRoot, path.join(output, "orchestrator", "dist"), (file) => file.endsWith(".js"));
  copyTree(
    path.join(root, "orchestrator", "workflows"),
    path.join(output, "orchestrator", "workflows"),
  );
  for (const relative of RUNTIME_SCRIPT_FILES) {
    copyRequiredFile(
      path.join(root, "scripts", ...relative.split("/")),
      path.join(output, "scripts", ...relative.split("/")),
    );
  }
  copyTree(path.join(root, "config"), path.join(output, "config"), (file) => {
    const relative = path.relative(path.join(root, "config"), file).replaceAll(path.sep, "/");
    return relative === "README.md" || relative.endsWith(".example.json");
  });
  for (const relative of RUNTIME_TEMPLATE_FILES) {
    copyRequiredFile(
      path.join(root, "missions-templates", ...relative.split("/")),
      path.join(output, "missions-templates", ...relative.split("/")),
    );
  }
  for (const relative of RUNTIME_WIKI_FILES) {
    copyRequiredFile(
      path.join(root, "wiki", relative),
      path.join(output, "wiki", relative),
    );
  }

  writeFileSync(
    path.join(output, "package.json"),
    `${JSON.stringify(runtimeScriptsPackage(root), null, 2)}\n`,
    "utf8",
  );
  mkdirSync(path.join(output, "orchestrator"), { recursive: true });
  writeFileSync(
    path.join(output, "orchestrator", "package.json"),
    `${JSON.stringify(orchestratorRuntimePackage(root), null, 2)}\n`,
    "utf8",
  );

  copyPackageFiles(root, output, "@openai/codex-sdk", (relative) =>
    relative === "package.json"
    || relative === "README.md"
    || relative === "LICENSE"
    || relative === "dist/index.js"
  );
  copyPackageFiles(root, output, "yaml", (relative) =>
    relative === "package.json"
    || relative === "LICENSE"
    || relative === "util.js"
    || (relative.startsWith("dist/") && relative.endsWith(".js"))
  );

  const assets = listRuntimeAssets(output);
  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  assertRuntimeSize(totalBytes);
  const manifest = {
    version: 1,
    node: ">=22.13.0",
    codexCli: "external-required",
    embeddedCodexPlatformBinary: false,
    totalBytes,
    assets,
  };
  writeFileSync(
    path.join(output, "runtime-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return validateStagedRuntime(output);
}

function isMainModule() {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath));
}

if (isMainModule()) {
  try {
    const verifyOnly = process.argv.slice(2).includes("--verify");
    const manifest = verifyOnly
      ? validateStagedRuntime(DEFAULT_RUNTIME_ROOT)
      : stageDesktopRuntime();
    process.stdout.write(
      `[juno] desktop runtime ${verifyOnly ? "verified" : "staged"}: ${manifest.assets.length} files, ${manifest.totalBytes} bytes\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[juno] desktop runtime packaging failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
