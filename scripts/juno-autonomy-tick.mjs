#!/usr/bin/env node
/**
 * Bounded autonomy tick: decide + optionally bootstrap next mission.
 * Usage: node scripts/juno-autonomy-tick.mjs [--execute] [--skip-build]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpmWithTimeout } from "./lib/pnpm-runner.mjs";
import {
  BOOTSTRAP_TIMEOUT_MS,
  BUILD_TIMEOUT_MS,
  checkedSpawnStatus,
  spawnWithTimeout,
} from "./lib/specialized-loop-guard.mjs";
import { MAX_MISSION_LIVE_TIMEOUT_MS } from "./run-mission-loop.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const AUTONOMY_TICK_GRACE_MS = 10 * 60_000;
const AUTONOMY_PARENT_GRACE_MS = 5 * 60_000;
export const MAX_AUTONOMY_TICK_TIMEOUT_MS =
  MAX_MISSION_LIVE_TIMEOUT_MS * 2 + AUTONOMY_TICK_GRACE_MS;
export const AUTONOMY_TICK_PARENT_TIMEOUT_MS =
  MAX_AUTONOMY_TICK_TIMEOUT_MS + AUTONOMY_PARENT_GRACE_MS;

export function normalizeAutonomyChildResult(result, label = "subprocess") {
  try {
    if (result?.timedOut) throw new Error(`${label} timed out`);
    if (result?.signal) throw new Error(`${label} terminated by ${result.signal}`);
    if (result?.terminationConfirmed === false) {
      throw new Error(`${label} process tree termination was not confirmed`);
    }
    return { exitCode: checkedSpawnStatus(result, label), error: null };
  } catch (error) {
    return {
      exitCode: 1,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runAutonomyTick(argv = process.argv.slice(2)) {
  const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
  const execute = argv.includes("--execute");
  const skipBuild =
    argv.includes("--skip-build") || process.env.JUNO_SKIP_ORCHESTRATOR_BUILD === "1";

  process.env.AGENT_WORKBENCH_ROOT = workbench;
  process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

  const shutdownController = new AbortController();
  let stopSignal = null;
  const requestStop = (signal) => {
    if (stopSignal) return;
    stopSignal = signal;
    process.stderr.write(`[autonomy] ${signal} - stopping active child tree\n`);
    shutdownController.abort();
  };
  const onSigint = () => requestStop("SIGINT");
  const onSigterm = () => requestStop("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const signalExitCode = () => (stopSignal === "SIGINT" ? 130 : 143);
  const spawnNode = (args, timeoutMs = MAX_AUTONOMY_TICK_TIMEOUT_MS, options = {}) =>
    spawnWithTimeout(
      process.execPath,
      args,
      {
        cwd: repoRoot,
        stdio: "inherit",
        signal: shutdownController.signal,
        ...options,
      },
      timeoutMs,
    );
  const spawnPnpm = (args, timeoutMs = MAX_AUTONOMY_TICK_TIMEOUT_MS, options = {}) =>
    spawnPnpmWithTimeout(
      args,
      {
        cwd: repoRoot,
        stdio: "inherit",
        signal: shutdownController.signal,
        ...options,
      },
      timeoutMs,
    );

  let settlePendingReservation = null;

  try {
    if (!skipBuild) {
      const build = await spawnPnpm(["orchestrator:build"], BUILD_TIMEOUT_MS);
      if (stopSignal) return signalExitCode();
      const buildOutcome = normalizeAutonomyChildResult(build, "orchestrator build");
      if (buildOutcome.exitCode !== 0) {
        process.stderr.write(
          `[autonomy] ${buildOutcome.error ?? `orchestrator build exited ${buildOutcome.exitCode}`}\n`,
        );
        return buildOutcome.exitCode;
      }
    }

    const { loadProjectEnv } = await import("../orchestrator/dist/env.js");
    loadProjectEnv();
    const { decideNextAction, reserveAutonomyDecision, settleAutonomyDecision } = await import(
      "../orchestrator/dist/bounded-autonomy.js"
    );

    if (execute) {
      const { recoverPendingVerifyCompletions } = await import(
        "../orchestrator/dist/mission-completion.js"
      );
      const recovery = recoverPendingVerifyCompletions(workbench);
      if (recovery.status === "busy") {
        process.stderr.write("[autonomy] completion recovery busy\n");
        return 4;
      }
      if (recovery.status === "blocked") {
        process.stderr.write(`[autonomy] completion recovery blocked: ${recovery.reason}\n`);
        return 5;
      }
      if (recovery.status === "recovered") {
        process.stderr.write(
          `[autonomy] recovered completion ${recovery.recovered
            .map((entry) => entry.terminalRunId)
            .join(",")}\n`,
        );
        return 0;
      }
    }

    const decision = decideNextAction(workbench);
    console.log(JSON.stringify(decision, null, 2));

    if (!execute) {
      console.error("\n[dry-run] pass --execute to apply (respects daily caps)");
      return 0;
    }

    const reservation = reserveAutonomyDecision(workbench, decision);
    let reservationSettled = false;
    const finish = (succeeded, detail) => {
      if (reservationSettled) return;
      settleAutonomyDecision(workbench, reservation.actionId, decision, { succeeded, detail });
      reservationSettled = true;
    };
    settlePendingReservation = () => {
      if (!reservationSettled) finish(false, "autonomy tick exited before explicit settlement");
    };
    const finishChild = (result, label) => {
      if (stopSignal) {
        finish(false, `interrupted by ${stopSignal}`);
        return signalExitCode();
      }
      const outcome = normalizeAutonomyChildResult(result, label);
      finish(
        outcome.exitCode === 0,
        outcome.error ?? `${label} exited ${outcome.exitCode}`,
      );
      if (outcome.error) process.stderr.write(`[autonomy] ${outcome.error}\n`);
      return outcome.exitCode;
    };

    if (decision.action === "run_local_loop") {
      return finishChild(await spawnPnpm([decision.script]), decision.script);
    }

    if (decision.action === "run_agi_loop") {
      return finishChild(
        await spawnNode([
          "scripts/run-agi-literature-loop.mjs",
          "--skip-autonomy",
          "--max-slots=2",
        ]),
        "AGI literature loop",
      );
    }

    if (decision.action === "run_book_loop") {
      return finishChild(
        await spawnNode([
          "scripts/run-axiom-book-loop.mjs",
          "--skip-autonomy",
          "--max-slots=2",
        ]),
        "axiom book loop",
      );
    }

    if (decision.action === "run_book_quality_loop") {
      return finishChild(
        await spawnNode(["scripts/run-book-quality-loop.mjs", "--max-slots=2"]),
        "book quality loop",
      );
    }

    if (decision.action === "run_self_optimize") {
      return finishChild(
        await spawnNode(["scripts/run-self-optimize.mjs"]),
        "self optimize",
      );
    }

    if (decision.action === "run_generic_loop") {
      const script = decision.script ?? "mission:loop";
      let result;
      if (script === "mission:loop") {
        result = await spawnNode(["scripts/run-mission-loop.mjs", "--skip-build"], undefined, {
          env: { ...process.env, JUNO_SKIP_ORCHESTRATOR_BUILD: "1" },
        });
      } else if (script.endsWith(".mjs")) {
        result = await spawnNode([`scripts/${script}`]);
      } else if (script === "evolution:tick") {
        result = await spawnNode(["scripts/run-evolution-tick.mjs", "--skip-build"], undefined, {
          env: { ...process.env, JUNO_SKIP_ORCHESTRATOR_BUILD: "1" },
        });
      } else {
        result = await spawnPnpm([script]);
      }
      return finishChild(result, script);
    }

    if (decision.action === "queue_mission") {
      let result;
      if (decision.bootstrap === "queue:agi-literature") {
        result = await spawnNode(["scripts/bootstrap-agi-literature.mjs"], BOOTSTRAP_TIMEOUT_MS);
      } else if (decision.bootstrap === "queue:axiom-book") {
        result = await spawnNode(["scripts/bootstrap-axiom-book.mjs"], BOOTSTRAP_TIMEOUT_MS);
      } else if (decision.bootstrap === "queue:hardening") {
        result = await spawnNode(["scripts/queue-hardening.mjs"], BOOTSTRAP_TIMEOUT_MS);
      } else if (decision.bootstrap === "queue:book-quality") {
        result = await spawnNode(
          ["scripts/bootstrap-book-quality-revise.mjs"],
          BOOTSTRAP_TIMEOUT_MS,
        );
      } else if (decision.bootstrap === "queue:workbench-cleanup") {
        result = await spawnNode(
          ["scripts/bootstrap-workbench-cleanup.mjs"],
          BOOTSTRAP_TIMEOUT_MS,
        );
      } else {
        finish(false, `unsupported bootstrap: ${String(decision.bootstrap)}`);
        process.stderr.write(`[autonomy] unsupported bootstrap: ${decision.bootstrap}\n`);
        return 1;
      }
      return finishChild(result, decision.bootstrap);
    }

    if (decision.action === "escalate_human") {
      finish(false, `${decision.reason}: ${decision.detail}`);
      console.error(`[autonomy] paused: ${decision.reason} - ${decision.detail}`);
      return 2;
    }

    if (decision.action === "stop") {
      finish(false, decision.reason);
      return 0;
    }

    finish(false, `unsupported decision action: ${String(decision.action)}`);
    process.stderr.write(`[autonomy] unsupported decision action: ${String(decision.action)}\n`);
    return 1;
  } finally {
    settlePendingReservation?.();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

function isMainModule() {
  return Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath));
}

if (isMainModule()) {
  try {
    process.exitCode = await runAutonomyTick();
  } catch (error) {
    process.stderr.write(
      `[autonomy] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
