#!/usr/bin/env node
/** Inspect by default; archive strict legacy v0 only after an exact-hash commit. */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnPnpmWithTimeout } from "./lib/pnpm-runner.mjs";
import { BUILD_TIMEOUT_MS, requireSpawnSuccess } from "./lib/specialized-loop-guard.mjs";
import { parseWorkflowSelectionMigrationArgs } from "./lib/workflow-selection-migration-args.mjs";

const args = parseWorkflowSelectionMigrationArgs(process.argv.slice(2));
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

if (!args.skipBuild) {
  requireSpawnSuccess(
    await spawnPnpmWithTimeout(
      ["orchestrator:build"],
      { cwd: repoRoot, stdio: "inherit" },
      BUILD_TIMEOUT_MS,
    ),
    "orchestrator build",
  );
}

const modulePath = path.join(repoRoot, "orchestrator", "dist", "workflow-experiment.js");
const migration = await import(`${pathToFileURL(modulePath).href}?selection-migration=${Date.now()}`);
const result = args.commit
  ? migration.migrateLegacyWorkflowSelection(workbench, {
      expectedSha256: args.expectedSha256,
      reason: args.reason,
    })
  : migration.inspectWorkflowSelectionMigration(workbench);

console.log(JSON.stringify({ action: args.commit ? "commit" : "inspect", result }, null, 2));
