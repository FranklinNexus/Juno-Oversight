#!/usr/bin/env node
/** Manual-only workflow canary controller. No action flag means propose/inspect only. */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnPnpmWithTimeout } from "./lib/pnpm-runner.mjs";
import { BUILD_TIMEOUT_MS, requireSpawnSuccess } from "./lib/specialized-loop-guard.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

function option(name) {
  const prefix = `--${name}=`;
  const matches = process.argv.slice(2).filter((arg) => arg.startsWith(prefix));
  if (matches.length > 1) throw new Error(`Duplicate --${name}`);
  return matches[0]?.slice(prefix.length);
}

function positiveInteger(name, fallback) {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

const knownBareFlags = new Set([
  "--queue",
  "--evaluate",
  "--promote",
  "--rollback",
  "--skip-build",
]);
const knownOptions = new Set([
  "id",
  "baseline",
  "candidate",
  "target-mission",
  "source-phase",
  "episodes",
]);
for (const arg of process.argv.slice(2)) {
  if (knownBareFlags.has(arg)) continue;
  const match = arg.match(/^--([^=]+)=/);
  if (!match || !knownOptions.has(match[1])) throw new Error(`Unknown argument: ${arg}`);
}
for (const name of knownOptions) option(name);
const hasProposalDefinition = ["baseline", "candidate", "target-mission"]
  .some((name) => option(name) !== undefined);
if (!hasProposalDefinition && ["source-phase", "episodes"].some((name) => option(name) !== undefined)) {
  throw new Error("--source-phase and --episodes require a workflow proposal definition");
}

const mutationFlags = ["--queue", "--evaluate", "--promote", "--rollback"]
  .filter((flag) => process.argv.includes(flag));
if (mutationFlags.length > 1) {
  throw new Error(`Use one explicit action at a time: ${mutationFlags.join(", ")}`);
}

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

if (!process.argv.includes("--skip-build")) {
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
const experiments = await import(`${pathToFileURL(modulePath).href}?manual=${Date.now()}`);

let experimentId = option("id");
const baselineWorkflowId = option("baseline");
const candidateWorkflowId = option("candidate");
const targetMissionId = option("target-mission");
if (baselineWorkflowId || candidateWorkflowId || targetMissionId) {
  if (!baselineWorkflowId || !candidateWorkflowId || !targetMissionId) {
    throw new Error("Proposal requires --baseline, --candidate, and --target-mission together");
  }
  const proposal = experiments.proposeWorkflowExperiment(workbench, {
    experimentId,
    baselineWorkflowId,
    candidateWorkflowId,
    targetMissionId,
    sourcePhaseId: option("source-phase") ?? "workflow-canary",
    requiredEpisodes: positiveInteger("episodes", 2),
  });
  experimentId = proposal.experimentId;
}

if (!experimentId) {
  const ids = experiments.listWorkflowExperimentIds(workbench);
  console.log(JSON.stringify(ids.map((id) => experiments.inspectWorkflowExperiment(workbench, id)), null, 2));
  process.exit(0);
}

let actionResult = null;
if (process.argv.includes("--queue")) {
  actionResult = experiments.queueWorkflowExperiment(workbench, experimentId);
} else if (process.argv.includes("--evaluate")) {
  actionResult = experiments.evaluateWorkflowExperiment(workbench, experimentId);
} else if (process.argv.includes("--promote")) {
  actionResult = experiments.promoteWorkflowExperiment(workbench, experimentId);
} else if (process.argv.includes("--rollback")) {
  actionResult = experiments.rollbackWorkflowExperiment(workbench, experimentId);
}

console.log(JSON.stringify({
  action: mutationFlags[0]?.slice(2) ?? "inspect",
  actionResult,
  experiment: experiments.inspectWorkflowExperiment(workbench, experimentId),
}, null, 2));
