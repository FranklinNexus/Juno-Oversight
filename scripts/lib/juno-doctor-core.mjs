import { existsSync } from "node:fs";
import path from "node:path";
import { readControlSnapshot } from "./juno-control-core.mjs";

function semverParts(version) {
  return String(version).replace(/^v/, "").split(".").map(Number);
}

function nodeSupported(version) {
  const [major, minor] = semverParts(version);
  return major > 22 || (major === 22 && minor >= 13);
}

export function collectDoctorReport(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const workbench = path.resolve(options.workbench);
  const requireLive = options.requireLive === true;
  const checks = [];
  const add = (id, status, detail, fix = null) => checks.push({
    id,
    status,
    detail,
    fix: status === "pass" ? null : fix,
  });

  add(
    "node",
    nodeSupported(process.version) ? "pass" : "fail",
    process.version,
    "Install Node.js 22.13 or newer",
  );
  add(
    "repo",
    existsSync(path.join(repoRoot, "package.json")) ? "pass" : "fail",
    repoRoot,
    "Run the command from the Juno repository",
  );
  add(
    "dependencies",
    existsSync(path.join(repoRoot, "node_modules", "next", "package.json")) ? "pass" : "fail",
    "root node_modules",
    "Run pnpm install",
  );
  add(
    "orchestrator_dependencies",
    existsSync(path.join(repoRoot, "orchestrator", "node_modules", "@cursor", "sdk"))
      ? "pass"
      : "fail",
    "@cursor/sdk",
    "Run pnpm orchestrator:build",
  );
  add(
    "workbench",
    existsSync(workbench) ? "pass" : "fail",
    workbench,
    "Run pnpm juno:setup",
  );
  for (const relative of [
    "config.yaml",
    path.join("queue", "now.yaml"),
    path.join("state", "orchestrator.json"),
    path.join("state", "scheduler.json"),
  ]) {
    const file = path.join(workbench, relative);
    add(
      `workbench_${relative.replace(/[\\/.]/g, "_")}`,
      existsSync(file) ? "pass" : "fail",
      file,
      "Run pnpm juno:setup",
    );
  }
  add(
    "safety_hooks",
    existsSync(path.join(workbench, ".cursor", "hooks.json")) ? "pass" : "fail",
    path.join(workbench, ".cursor", "hooks.json"),
    "Run pnpm juno:setup to install the safety hooks",
  );

  const hasLiveKey = Boolean(process.env.CURSOR_API_KEY?.trim());
  add(
    "cursor_api_key",
    hasLiveKey ? "pass" : requireLive ? "fail" : "warn",
    hasLiveKey ? "configured" : "not configured",
    "Add CURSOR_API_KEY to .env.local",
  );

  let runtime = null;
  if (existsSync(path.join(workbench, "queue", "now.yaml"))) {
    runtime = readControlSnapshot(workbench, null, { pidChecker: options.pidChecker });
    add(
      "scheduler_enabled",
      runtime.schedulerEnabled ? "pass" : requireLive ? "fail" : "warn",
      runtime.schedulerEnabled ? "enabled" : "disabled",
      "Submit a juno:control task or set state/scheduler.json enabled=true",
    );
    add(
      "scheduler",
      runtime.schedulerRunning ? "pass" : "warn",
      runtime.schedulerRunning ? `running pid=${runtime.schedulerPid}` : "not running",
      "Run pnpm juno:daemon or submit a juno:control task",
    );
    if (runtime.schedulerRunning && runtime.schedulerLastTickAt) {
      const ageMs = Date.now() - Date.parse(runtime.schedulerLastTickAt);
      add(
        "scheduler_heartbeat",
        Number.isFinite(ageMs) && ageMs <= 30_000 ? "pass" : "fail",
        `${Math.max(0, Math.round(ageMs / 1000))}s old`,
        "Restart the scheduler with pnpm juno:daemon",
      );
    }
  }

  const failed = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  return {
    ok: failed.length === 0,
    readyForSmoke: failed.filter((check) => check.id !== "cursor_api_key").length === 0,
    readyForLive: failed.length === 0 && hasLiveKey && runtime?.schedulerEnabled !== false,
    repoRoot,
    workbench,
    summary: { passed: checks.filter((check) => check.status === "pass").length, warnings: warnings.length, failed: failed.length },
    checks,
    runtime,
  };
}
