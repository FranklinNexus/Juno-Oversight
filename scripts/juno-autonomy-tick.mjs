#!/usr/bin/env node
/**
 * Bounded autonomy tick: decide + optionally bootstrap next mission.
 * Usage: node scripts/juno-autonomy-tick.mjs [--execute] [--skip-build]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";
const execute = process.argv.includes("--execute");
const skipBuild =
  process.argv.includes("--skip-build") || process.env.JUNO_SKIP_ORCHESTRATOR_BUILD === "1";

process.env.AGENT_WORKBENCH_ROOT = workbench;
process.env.JUNO_OVERSIGHT_ROOT = repoRoot;

if (!skipBuild) {
  const build = spawnSync("pnpm", ["orchestrator:build"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const { loadProjectEnv } = await import("../orchestrator/dist/env.js");
loadProjectEnv();

const { decideNextAction, recordAutonomyDecision } = await import(
  "../orchestrator/dist/bounded-autonomy.js"
);

const decision = decideNextAction(workbench);
console.log(JSON.stringify(decision, null, 2));

if (!execute) {
  console.error("\n[dry-run] pass --execute to apply (respects daily caps)");
  process.exit(0);
}

function finish(succeeded) {
  recordAutonomyDecision(workbench, decision, { succeeded });
}

if (decision.action === "run_local_loop") {
  const r = spawnSync("pnpm", [decision.script], { cwd: repoRoot, stdio: "inherit", shell: true });
  finish(r.status === 0);
  process.exit(r.status ?? 1);
}

if (decision.action === "run_agi_loop") {
  const r = spawnSync("node", ["scripts/run-agi-literature-loop.mjs", "--skip-autonomy"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  finish(r.status === 0);
  process.exit(r.status ?? 1);
}

if (decision.action === "run_book_loop") {
  const r = spawnSync("node", ["scripts/run-axiom-book-loop.mjs", "--skip-autonomy", "--max-slots=2"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  finish(r.status === 0);
  process.exit(r.status ?? 1);
}

if (decision.action === "run_book_quality_loop") {
  const r = spawnSync("node", ["scripts/run-book-quality-loop.mjs", "--max-slots=2"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  finish(r.status === 0);
  process.exit(r.status ?? 1);
}

if (decision.action === "run_self_optimize") {
  const r = spawnSync("node", ["scripts/run-self-optimize.mjs"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  finish(r.status === 0);
  process.exit(r.status ?? 1);
}

if (decision.action === "run_generic_loop") {
  const script = decision.script ?? "mission:loop";
  let r;
  if (script === "mission:loop") {
    r = spawnSync("node", ["scripts/run-mission-loop.mjs", "--skip-build"], {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, JUNO_SKIP_ORCHESTRATOR_BUILD: "1" },
    });
  } else if (script.endsWith(".mjs")) {
    r = spawnSync("node", [`scripts/${script}`], { cwd: repoRoot, stdio: "inherit" });
  } else if (script === "evolution:tick") {
    r = spawnSync("node", ["scripts/run-evolution-tick.mjs", "--skip-build"], {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, JUNO_SKIP_ORCHESTRATOR_BUILD: "1" },
    });
  } else {
    r = spawnSync("pnpm", [script], { cwd: repoRoot, stdio: "inherit", shell: true });
  }
  // exit 3 = gate hold · exit 4 = empty queue — neither burns daily cap
  finish(r.status === 0);
  process.exit(r.status ?? 1);
}

if (decision.action === "queue_mission") {
  let r;
  if (decision.bootstrap === "queue:agi-literature") {
    r = spawnSync("node", ["scripts/bootstrap-agi-literature.mjs"], { cwd: repoRoot, stdio: "inherit" });
  } else if (decision.bootstrap === "queue:axiom-book") {
    r = spawnSync("node", ["scripts/bootstrap-axiom-book.mjs"], { cwd: repoRoot, stdio: "inherit" });
  } else if (decision.bootstrap === "queue:hardening") {
    r = spawnSync("node", ["scripts/queue-hardening.mjs"], { cwd: repoRoot, stdio: "inherit" });
  } else if (decision.bootstrap === "queue:book-quality") {
    r = spawnSync("node", ["scripts/bootstrap-book-quality-revise.mjs"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } else if (decision.bootstrap === "queue:workbench-cleanup") {
    r = spawnSync("node", ["scripts/bootstrap-workbench-cleanup.mjs"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } else if (decision.bootstrap === "queue:runtime-overnight") {
    r = spawnSync("node", ["scripts/bootstrap-runtime-overnight.mjs", "--force-queue"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } else if (decision.bootstrap === "queue:daily-inbox") {
    r = spawnSync("node", ["scripts/bootstrap-daily-inbox.mjs", "--force-queue"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } else if (decision.bootstrap === "queue:wisdomechoes-blog") {
    r = spawnSync("node", ["scripts/bootstrap-wisdomechoes-blog.mjs", "--force-queue"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } else if (decision.bootstrap === "queue:nl-brief") {
    r = spawnSync("node", ["scripts/bootstrap-nl-brief.mjs", "--force-queue"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } else if (decision.bootstrap === "queue:hardware-mcp") {
    r = spawnSync("node", ["scripts/bootstrap-hardware-mcp.mjs", "--force-queue"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } else {
    finish(false);
    process.exit(1);
  }
  finish(r.status === 0);
  process.exit(r.status ?? 1);
}

if (decision.action === "escalate_human") {
  finish(false);
  console.error(`[autonomy] paused: ${decision.reason} — ${decision.detail}`);
  process.exit(2);
}

if (decision.action === "stop") {
  finish(false);
  process.exit(0);
}

process.exit(0);
