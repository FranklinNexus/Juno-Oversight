#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDoctorReport } from "./lib/juno-doctor-core.mjs";
import { defaultWorkbenchRoot, loadProjectEnv } from "./lib/project-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(repoRoot);
const args = process.argv.slice(2);
const report = collectDoctorReport({
  repoRoot,
  workbench: defaultWorkbenchRoot(),
  requireLive: args.includes("--live"),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok || (args.includes("--live") && !report.readyForLive)) process.exitCode = 2;
