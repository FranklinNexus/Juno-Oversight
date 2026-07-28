import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { updateEnvFile } from "./project-env.mjs";

const WORKBENCH_DIRS = [
  "config",
  "daily",
  "missions",
  "prompts",
  "providers",
  "queue",
  "runs",
  "staging",
  "state",
];

const DEFAULT_CONFIGS = ["api-limits", "mcp-servers", "metacognition", "model-defaults"];

function writeIfMissing(file, content, changes) {
  if (existsSync(file)) {
    changes.preserved.push(file);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
  changes.created.push(file);
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function initializeJuno(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const workbench = path.resolve(options.workbench);
  const envFile = path.resolve(options.envFile ?? path.join(repoRoot, ".env.local"));
  if (workbench === repoRoot || isInside(repoRoot, workbench)) {
    throw new Error("Workbench must be outside the repository");
  }

  const changes = { created: [], preserved: [], copied: [] };
  for (const dir of WORKBENCH_DIRS) mkdirSync(path.join(workbench, dir), { recursive: true });

  writeIfMissing(
    path.join(workbench, "config.yaml"),
    [
      "# Juno Workbench runtime configuration",
      "default_provider: cursor_composer",
      "quiet_hours:",
      '  start: "23:00"',
      '  end: "07:00"',
      "promote:",
      "  require_human: true",
      "",
    ].join("\n"),
    changes,
  );
  writeIfMissing(
    path.join(workbench, "queue", "now.yaml"),
    `updated: ${new Date().toISOString()}\nnow:\n  []\nbacklog:\n  []\n`,
    changes,
  );
  writeIfMissing(
    path.join(workbench, "state", "orchestrator.json"),
    `${JSON.stringify({
      activeRunId: null,
      activeRunStatus: "idle",
      activeWorkerPid: null,
      lastRunId: null,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    changes,
  );
  writeIfMissing(
    path.join(workbench, "state", "scheduler.json"),
    `${JSON.stringify({
      enabled: true,
      runsToday: 0,
      missionInjectIntervalMin: 90,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    changes,
  );

  for (const name of DEFAULT_CONFIGS) {
    const source = path.join(repoRoot, "config", `${name}.example.json`);
    const target = path.join(workbench, "config", `${name}.json`);
    if (!existsSync(source)) continue;
    writeIfMissing(target, readFileSync(source, "utf8"), changes);
  }

  const hooksSource = path.join(repoRoot, ".cursor");
  const hooksTarget = path.join(workbench, ".cursor");
  if (existsSync(hooksSource)) {
    cpSync(hooksSource, hooksTarget, { recursive: true, force: true });
    changes.copied.push(hooksTarget);
  }

  updateEnvFile(envFile, {
    AGENT_WORKBENCH_ROOT: workbench,
    JUNO_OVERSIGHT_ROOT: repoRoot,
  });

  return {
    ok: true,
    repoRoot,
    workbench,
    envFile,
    changes,
    next: [
      "Add CURSOR_API_KEY to .env.local for Live missions",
      "Run pnpm juno:doctor -- --live",
      "Run node scripts/juno-control.mjs run --brief \"your task\"",
    ],
  };
}
