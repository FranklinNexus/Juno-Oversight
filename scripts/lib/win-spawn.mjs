/**
 * Windows-friendly child processes: no flashing cmd.exe, optional detached daemon.
 */
import { spawn, spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";

function npmCmd() {
  return IS_WIN ? "npm.cmd" : "npm";
}

/** Run npm on Windows without flashing cmd — uses hidden cmd.exe /c. */
export function spawnNpm(args, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const base = quietSpawnOpts(cwd, opts);
  if (IS_WIN) {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", "npm", ...args], base);
  }
  return spawnSync("npm", args, base);
}

/** Default spawn options — hide console on Windows, never use shell unless forced. */
export function quietSpawnOpts(cwd, extra = {}) {
  return {
    cwd,
    shell: false,
    windowsHide: IS_WIN,
    ...extra,
  };
}

export function spawnQuiet(cmd, args, opts = {}) {
  return spawnSync(cmd, args, quietSpawnOpts(opts.cwd ?? process.cwd(), opts));
}

/** Same steps as package.json orchestrator:build, without pnpm/cmd.exe wrapper. */
export function runOrchestratorBuild(repoRoot, opts = {}) {
  const base = quietSpawnOpts(repoRoot, { stdio: opts.stdio ?? "inherit" });
  const steps = [
    ["node", ["scripts/check-node.mjs"]],
    ["node", ["scripts/install-orchestrator.mjs"]],
    ["node", ["scripts/check-orchestrator-deps.mjs"]],
    ["__npm__", ["run", "build", "--prefix", "orchestrator"]],
  ];
  for (const [cmd, args] of steps) {
    const r =
      cmd === "__npm__"
        ? spawnNpm(args, base)
        : spawnSync(cmd, args, base);
    if ((r.status ?? 1) !== 0) return r;
  }
  return { status: 0 };
}

/**
 * Start juno daemon fully detached — no visible window, logs appended to file.
 * Returns child pid or null on failure.
 */
export function startDaemonDetached(repoRoot, workbench) {
  const daemonScript = path.join(repoRoot, "scripts", "run-juno-daemon.mjs");
  const logPath = path.join(workbench, "state", "juno-daemon.log");
  const logFd = openSync(logPath, "a");

  const child = spawn(
    process.execPath,
    [daemonScript],
    quietSpawnOpts(repoRoot, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        AGENT_WORKBENCH_ROOT: workbench,
        JUNO_OVERSIGHT_ROOT: repoRoot,
        JUNO_DAEMON_DETACHED: "1",
      },
    }),
  );

  child.unref();
  return child.pid ?? null;
}
