#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readControlSnapshot,
  waitForMission,
} from "./lib/juno-control-core.mjs";
import { submitBrief } from "./lib/juno-submit-core.mjs";
import { quietSpawnOpts, runOrchestratorBuild } from "./lib/win-spawn.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const args = process.argv.slice(2);
const command = args[0] ?? "status";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

class ControlError extends Error {
  constructor(message, exitCode = 1, code = "CONTROL_ERROR") {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
  }
}

function option(name) {
  const exactIndex = args.indexOf(name);
  if (exactIndex >= 0) return args[exactIndex + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function positiveIntegerOption(name, fallback) {
  const raw = option(name);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ControlError(`${name} must be a positive integer`, 64, "INVALID_ARGUMENT");
  }
  return parsed;
}

function emitEvent(event, detail = {}) {
  process.stderr.write(`${JSON.stringify({ event, timestamp: new Date().toISOString(), ...detail })}\n`);
}

function emitResult(result, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

function buildOrchestrator() {
  emitEvent("building_orchestrator");
  const result = runOrchestratorBuild(repoRoot, { stdio: "pipe" });
  if ((result.status ?? 1) !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .map(String)
      .join("\n")
      .trim();
    throw new ControlError(
      `orchestrator build failed${detail ? `: ${detail.slice(-2000)}` : ""}`,
      1,
      "BUILD_FAILED",
    );
  }
}

async function ensureScheduler() {
  let snapshot = readControlSnapshot(workbench, null);
  if (snapshot.schedulerRunning) {
    if (!snapshot.schedulerEnabled) {
      const schedulerPath = path.join(workbench, "state", "scheduler.json");
      let state = {};
      try {
        state = JSON.parse(readFileSync(schedulerPath, "utf8"));
      } catch {
        state = {};
      }
      mkdirSync(path.dirname(schedulerPath), { recursive: true });
      writeFileSync(
        schedulerPath,
        `${JSON.stringify({ ...state, enabled: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
      emitEvent("scheduler_enabled");
      snapshot = readControlSnapshot(workbench, null);
    }
    return snapshot;
  }

  emitEvent("starting_scheduler");
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "start-juno-scheduler-hidden.mjs"), "--skip-build"],
    quietSpawnOpts(repoRoot, { encoding: "utf8" }),
  );
  if ((result.status ?? 1) !== 0) {
    throw new ControlError(
      `scheduler start failed: ${String(result.stderr ?? "").trim()}`,
      1,
      "SCHEDULER_START_FAILED",
    );
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    snapshot = readControlSnapshot(workbench, null);
    if (snapshot.schedulerRunning) return snapshot;
  }
  throw new ControlError("scheduler did not become ready within 5 seconds", 1, "SCHEDULER_NOT_READY");
}

function briefText() {
  const brief = option("--brief")?.trim();
  const file = option("--file");
  if (brief && file) {
    throw new ControlError("use either --brief or --file, not both", 64, "INVALID_ARGUMENT");
  }
  if (file) {
    const resolved = path.resolve(file);
    if (!existsSync(resolved)) {
      throw new ControlError(`brief file not found: ${resolved}`, 64, "BRIEF_NOT_FOUND");
    }
    const text = readFileSync(resolved, "utf8").trim();
    if (!text) throw new ControlError("brief file is empty", 64, "EMPTY_BRIEF");
    return { text, source: resolved };
  }
  if (!brief) {
    throw new ControlError("submit/run requires --brief <text> or --file <path>", 64, "EMPTY_BRIEF");
  }
  return { text: brief, source: "juno-control" };
}

function exitCodeForOutcome(outcome) {
  if (outcome === "complete") return 0;
  if (outcome === "blocked") return 2;
  if (outcome === "failed") return 3;
  if (outcome === "timeout") return 4;
  if (outcome === "missing") return 5;
  return 1;
}

async function waitCommand(missionId) {
  const timeoutMs = positiveIntegerOption("--timeout-ms", 30 * 60_000);
  const pollMs = positiveIntegerOption("--poll-ms", 2_000);
  let progressKey = "";
  return waitForMission({
    workbench,
    missionId,
    timeoutMs,
    pollMs,
    onProgress(snapshot, outcome) {
      const nextKey = [
        outcome,
        snapshot.phaseDone,
        snapshot.currentPhaseId,
        snapshot.activeRunId,
        snapshot.activeRunStatus,
        snapshot.queueDepth,
      ].join("|");
      if (nextKey === progressKey) return;
      progressKey = nextKey;
      emitEvent("mission_progress", {
        missionId,
        outcome,
        phaseDone: snapshot.phaseDone,
        phaseTotal: snapshot.phaseTotal,
        currentPhaseId: snapshot.currentPhaseId,
        activeRunId: snapshot.activeRunId,
        activeRunStatus: snapshot.activeRunStatus,
        queueDepth: snapshot.queueDepth,
      });
    },
  });
}

async function main() {
  if (!["status", "submit", "wait", "run"].includes(command)) {
    throw new ControlError(
      "usage: juno-control <status|submit|wait|run> [--mission id] [--brief text|--file path]",
      64,
      "INVALID_COMMAND",
    );
  }

  if (command === "status") {
    const snapshot = readControlSnapshot(workbench, option("--mission") ?? null);
    emitResult({ ok: true, command, ...snapshot });
    return;
  }

  if (command === "wait") {
    const missionId = option("--mission");
    if (!missionId) {
      throw new ControlError("wait requires --mission <id>", 64, "MISSION_REQUIRED");
    }
    let runtime = readControlSnapshot(workbench, missionId);
    if (!runtime.schedulerRunning) {
      buildOrchestrator();
    }
    runtime = await ensureScheduler();
    const waited = await waitCommand(missionId);
    emitResult(
      { ok: waited.outcome === "complete", command, ...waited },
      exitCodeForOutcome(waited.outcome),
    );
    return;
  }

  const brief = briefText();
  buildOrchestrator();
  await ensureScheduler();
  const submission = await submitBrief({
    repoRoot,
    workbench,
    text: brief.text,
    source: brief.source,
  });
  emitEvent("mission_submitted", {
    missionId: submission.missionId,
    phaseTotal: submission.phaseTotal,
  });

  if (command === "submit") {
    emitResult({
      ok: true,
      command,
      submission,
      snapshot: readControlSnapshot(workbench, submission.missionId),
    });
    return;
  }

  const waited = await waitCommand(submission.missionId);
  emitResult(
    {
      ok: waited.outcome === "complete",
      command,
      submission,
      ...waited,
    },
    exitCodeForOutcome(waited.outcome),
  );
}

main().catch((error) => {
  const controlled = error instanceof ControlError;
  emitResult(
    {
      ok: false,
      command,
      error: {
        code: controlled ? error.code : "UNEXPECTED_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    },
    controlled ? error.exitCode : 1,
  );
});
