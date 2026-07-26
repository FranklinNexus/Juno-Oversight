import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendEvent, touchHeartbeat } from "./events.js";
import {
  EXECUTION_ARTIFACT_VERSION,
  evidenceSha256,
  executionAttemptBinding,
  manifestEvidenceSha256,
  verifyStepId,
  type ExecutionAttemptBinding,
} from "./execution-artifact.js";
import { junoProjectRoot, nowIso, workbenchRoot } from "./env.js";
import { normalizeEvalProfile, verifyStepsForProfile, type VerifyStep } from "./eval-profile.js";
import {
  resolveLiteratureVerificationBinding,
  verifyLiteratureArtifacts,
  type ArtifactCheck,
} from "./literature-verify.js";
import { resolveRepoCwd } from "./manifest.js";
import {
  formatSafetyVerifyMarkdown,
  runMissionDiffSafetyVerify,
} from "./safety-verify.js";
import { redactSensitiveText } from "./secret-redaction.js";
import type { RunManifest } from "./types.js";

const OUTPUT_LIMIT = 8_000;

export interface VerifyStepResult {
  stepId: string;
  label: string;
  command: string;
  exitCode: number;
  durationMs: number;
  optional: boolean;
  ok: boolean;
  terminationConfirmed: boolean;
  stdout: string;
  stderr: string;
}

export interface VerifyRunResult {
  ok: boolean;
  profile: string;
  steps: VerifyStepResult[];
  checkpoint: string;
  terminationConfirmed: boolean;
}

export interface VerifyCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
  aborted: boolean;
  terminationConfirmed: boolean;
}

export interface VerifyCommandDependencies {
  killTree?: (pid: number) => boolean;
  isAlive?: (pid: number) => boolean;
  forceSettleMs?: number;
}

const VERIFY_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "CI",
] as const;

export function buildVerifyEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const nodeEnv: "development" | "production" | "test" =
    source.NODE_ENV === "development" || source.NODE_ENV === "production"
      ? source.NODE_ENV
      : "test";
  const env: NodeJS.ProcessEnv = { FORCE_COLOR: "0", NODE_ENV: nodeEnv };
  const entries = Object.entries(source);
  for (const wanted of VERIFY_ENV_KEYS) {
    const found = entries.find(([key, value]) => key.toLowerCase() === wanted.toLowerCase() && value);
    if (found?.[1]) env[found[0]] = found[1];
  }
  return env;
}

export function redactVerifyOutput(
  value: string | Buffer | null | undefined,
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return redactSensitiveText(value, source).slice(-OUTPUT_LIMIT);
}

function commandForStep(step: VerifyStep): { command: string; args: string[] } {
  if (step.cmd !== "pnpm") return { command: step.cmd, args: step.args };

  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /pnpm/i.test(path.basename(npmExecPath)) && existsSync(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...step.args] };
  }
  const nodeDir = path.dirname(process.execPath);
  const pnpmEntry = path.join(nodeDir, "node_modules", "corepack", "dist", "pnpm.js");
  if (existsSync(pnpmEntry)) {
    return { command: process.execPath, args: [pnpmEntry, ...step.args] };
  }
  const corepackEntry = path.join(nodeDir, "node_modules", "corepack", "dist", "corepack.js");
  if (existsSync(corepackEntry)) {
    return { command: process.execPath, args: [corepackEntry, "pnpm", ...step.args] };
  }
  if (process.platform === "win32") {
    return { command: "__juno_corepack_not_found__", args: [] };
  }
  return { command: "corepack", args: ["pnpm", ...step.args] };
}

export function verifyStepInvocationEvidence(step: VerifyStep): {
  tool: string;
  args: string;
  command: string;
} {
  const invocation = commandForStep(step);
  const tool = redactVerifyOutput(invocation.command);
  const args = redactVerifyOutput(invocation.args.join(" "));
  return {
    tool,
    args,
    command: redactVerifyOutput([invocation.command, ...invocation.args].join(" ")),
  };
}

function formatCheckpoint(profile: string, steps: VerifyStepResult[]): string {
  const terminationConfirmed = steps.every((step) => step.terminationConfirmed);
  const requiredOk = terminationConfirmed && steps.every((step) => step.optional || step.ok);
  const lines = [
    "# Deterministic Verify",
    "",
    "## VERIFY_REPORT",
    `- verdict: ${requiredOk ? "PASS" : "FAIL"}`,
    `- profile: ${profile}`,
    `- termination_confirmed: ${terminationConfirmed ? "true" : "false"}`,
  ];
  for (const step of steps) {
    const status = step.ok ? "PASS" : step.optional ? "WARN" : "FAIL";
    lines.push(
      `- ${step.label}: ${status} (exit_code=${step.exitCode}, duration_ms=${step.durationMs}${
        step.optional ? ", optional=true" : ""
      })`,
    );
  }
  lines.push("", "## VERIFY_EVIDENCE", "- source: orchestrator/verify-runner", "");
  return lines.join("\n");
}

export function runVerifySteps(
  manifest: RunManifest,
  runDir: string,
  cwd: string,
  steps: VerifyStep[],
  initialResults: VerifyStepResult[] = [],
  attempt: ExecutionAttemptBinding = executionAttemptBinding(manifest.runId, 1, 0),
): Promise<VerifyRunResult> {
  return runVerifyStepsAsync(manifest, runDir, cwd, steps, initialResults, attempt);
}

function appendTail(current: string, chunk: Buffer | string): string {
  const combined = current + String(chunk);
  return combined.length > 10 * 1024 * 1024 ? combined.slice(-10 * 1024 * 1024) : combined;
}

function killProcessTree(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const terminator = path.join(junoProjectRoot(), "scripts", "terminate-process-tree.ps1");
      const result = spawnSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        terminator,
        "-RootPid",
        String(pid),
      ], {
        stdio: "ignore",
        shell: false,
        windowsHide: true,
        timeout: 15_000,
      });
      return result.status === 0 && !processIsAlive(pid);
    } else {
      process.kill(-pid, "SIGKILL");
      return true;
    }
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export const VERIFY_HEARTBEAT_INTERVAL_MS = 30_000;

export function startVerifyHeartbeat(
  runDir: string,
  intervalMs = VERIFY_HEARTBEAT_INTERVAL_MS,
  onError: (error: unknown) => void = () => {},
): () => void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Verify heartbeat interval must be a positive safe integer");
  }
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      touchHeartbeat(runDir);
    } catch (error) {
      stopped = true;
      clearInterval(timer);
      onError(error);
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  dependencies: VerifyCommandDependencies = {},
): Promise<VerifyCommandResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error(`Invalid verify command timeout: ${timeoutMs}`);
  }
  const killTree = dependencies.killTree ?? killProcessTree;
  const isAlive = dependencies.isAlive ?? processIsAlive;
  const forceSettleMs = dependencies.forceSettleMs ?? 2_000;
  if (!Number.isSafeInteger(forceSettleMs) || forceSettleMs < 1) {
    throw new Error("Invalid verify force-settle timeout");
  }
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let error = "";
    let settled = false;
    let forceSettleTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let aborted = false;
    let terminationRequested = false;
    let terminationConfirmed = true;
    let treeTerminationConfirmed = true;
    const child = spawn(command, args, {
      cwd,
      env: buildVerifyEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk);
    });
    child.on("error", (cause) => {
      error = cause.message;
    });
    const settle = (code: number | null): void => {
      if (settled) return;
      if (terminationRequested && child.pid) {
        terminationConfirmed = treeTerminationConfirmed && !isAlive(child.pid);
        if (!terminationConfirmed && !error.includes("termination unconfirmed")) {
          error = `${error}; process tree termination unconfirmed`;
        }
      }
      settled = true;
      clearTimeout(timer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      signal?.removeEventListener("abort", abortCommand);
      resolve({
        exitCode: typeof code === "number" ? code : 1,
        stdout,
        stderr,
        error: error || undefined,
        timedOut,
        aborted,
        terminationConfirmed,
      });
    };

    const requestTermination = (reason: string, kind: "timeout" | "abort"): void => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      timedOut = kind === "timeout";
      aborted = kind === "abort";
      error = reason;
      if (child.pid && !killTree(child.pid)) {
        treeTerminationConfirmed = false;
        try {
          child.kill("SIGKILL");
        } catch {
          /* The process may already have exited. */
        }
      }
      forceSettleTimer = setTimeout(() => {
        if (child.pid && isAlive(child.pid) && !killTree(child.pid)) {
          treeTerminationConfirmed = false;
        }
        const alive = Boolean(child.pid && isAlive(child.pid));
        terminationConfirmed = treeTerminationConfirmed && !alive;
        error = `${error}; process did not report close after termination${
          terminationConfirmed ? "" : "; process tree termination unconfirmed"
        }`;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle(null);
      }, forceSettleMs);
    };

    const abortCommand = (): void => {
      requestTermination("command aborted", "abort");
    };
    const timer = setTimeout(() => {
      requestTermination(`command timed out after ${timeoutMs}ms`, "timeout");
    }, timeoutMs);
    child.on("close", settle);
    if (signal) {
      signal.addEventListener("abort", abortCommand, { once: true });
      if (signal.aborted) abortCommand();
    }
  });
}

async function runVerifyStepsAsync(
  manifest: RunManifest,
  runDir: string,
  cwd: string,
  steps: VerifyStep[],
  initialResults: VerifyStepResult[],
  attempt: ExecutionAttemptBinding,
): Promise<VerifyRunResult> {
  mkdirSync(runDir, { recursive: true });
  const eventsPath = path.join(runDir, "events.jsonl");
  const profile = normalizeEvalProfile(manifest.evalProfile);
  const results: VerifyStepResult[] = [...initialResults];
  const timeoutMs = Math.max(1, manifest.maxMinutes) * 60_000;
  const deadline = Date.now() + timeoutMs;

  appendEvent(eventsPath, {
    ts: nowIso(),
    type: "status",
    status: "verify_starting",
    detail: `profile=${profile}; steps=${steps.length}; artifact_checks=${initialResults.length}`,
    ...attempt,
  });
  touchHeartbeat(runDir);

  for (const step of steps) {
    const stepId = verifyStepId(step);
    const started = Date.now();
    const invocation = commandForStep(step);
    const evidence = verifyStepInvocationEvidence(step);
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "tool_call",
      tool: evidence.tool,
      args: evidence.args,
      stepId,
      phase: "started",
      ...attempt,
    });
    const remainingMs = deadline - Date.now();
    let heartbeatError = "";
    const stopHeartbeat = startVerifyHeartbeat(runDir, VERIFY_HEARTBEAT_INTERVAL_MS, (error) => {
      heartbeatError = error instanceof Error ? error.message : String(error);
    });
    let result: VerifyCommandResult;
    try {
      result =
        remainingMs > 0
          ? await runCommand(invocation.command, invocation.args, cwd, remainingMs)
          : {
              exitCode: 1,
              stdout: "",
              stderr: "",
              error: "verify deadline exhausted",
              timedOut: true,
              aborted: false,
              terminationConfirmed: true,
            };
    } finally {
      stopHeartbeat();
    }
    if (heartbeatError) {
      result.error = [result.error, `verify heartbeat failed: ${heartbeatError}`]
        .filter(Boolean)
        .join("; ");
    }
    const exitCode = result.exitCode;
    const stepResult: VerifyStepResult = {
      stepId,
      label: redactVerifyOutput(step.label),
      command: evidence.command,
      exitCode,
      durationMs: Date.now() - started,
      optional: step.optional === true,
      ok: exitCode === 0 && !result.error && result.terminationConfirmed,
      terminationConfirmed: result.terminationConfirmed,
      stdout: redactVerifyOutput(result.stdout),
      stderr: redactVerifyOutput([result.stderr, result.error].filter(Boolean).join("\n")),
    };
    results.push(stepResult);
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "tool_call",
      tool: evidence.tool,
      args: evidence.args,
      ok: stepResult.ok,
      stepId,
      phase: "completed",
      ...attempt,
    });
    touchHeartbeat(runDir);
    if (!stepResult.terminationConfirmed) break;
  }

  const checkpoint = formatCheckpoint(profile, results);
  const terminationConfirmed = results.every((step) => step.terminationConfirmed);
  const ok = terminationConfirmed && results.every((step) => step.optional || step.ok);
  writeFileSync(path.join(runDir, "checkpoint.md"), `${checkpoint}\n`, "utf8");
  appendEvent(eventsPath, {
    ts: nowIso(),
    type: "finished",
    status: ok ? "finished" : "error",
    result: `deterministic verify ${ok ? "PASS" : "FAIL"}`,
    model: "deterministic",
  });
  const checkpointText = readFileSync(path.join(runDir, "checkpoint.md"), "utf8");
  const eventsText = readFileSync(eventsPath, "utf8");
  writeFileSync(
    path.join(runDir, "verify-artifact.json"),
    `${JSON.stringify(
      {
        version: EXECUTION_ARTIFACT_VERSION,
        runId: manifest.runId,
        ...attempt,
        profile,
        cwd,
        verifiedAt: nowIso(),
        ok,
        terminationConfirmed,
        manifestSha256: manifestEvidenceSha256(manifest),
        checkpointSha256: evidenceSha256(checkpointText),
        eventsSha256: evidenceSha256(eventsText),
        steps: results,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { ok, profile, steps: results, checkpoint, terminationConfirmed };
}

function artifactResults(checks: ArtifactCheck[]): VerifyStepResult[] {
  return checks.map((check) => ({
    stepId: evidenceSha256(JSON.stringify({
      command: "orchestrator:artifact-check",
      label: check.label,
    })),
    label: redactVerifyOutput(check.label),
    command: "orchestrator:artifact-check",
    exitCode: check.ok ? 0 : 1,
    durationMs: 0,
    optional: false,
    ok: check.ok,
    terminationConfirmed: true,
    stdout: redactVerifyOutput(check.detail),
    stderr: "",
  }));
}

export function literatureArtifactChecksForManifest(
  workbench: string,
  manifest: RunManifest,
): ArtifactCheck[] {
  const binding = resolveLiteratureVerificationBinding(workbench, manifest);
  if (!binding.ok) return binding.checks;
  return [
    ...binding.checks,
    ...verifyLiteratureArtifacts(
      workbench,
      binding.validatorMissionId,
      binding.artifactMissionId,
      binding.artifactMode,
      binding.expectedFixtureFiles,
    ),
  ];
}

function safetyPreflightResult(workbench: string, manifest: RunManifest): VerifyStepResult | null {
  if (!manifest.missionId) return null;
  const report = runMissionDiffSafetyVerify(workbench, manifest.missionId);
  const detail = formatSafetyVerifyMarkdown(report);
  return {
    stepId: evidenceSha256(JSON.stringify({
      command: "orchestrator:safety-verify",
      label: "mission safety preflight",
    })),
    label: "mission safety preflight",
    command: "orchestrator:safety-verify",
    exitCode: report.ok ? 0 : 1,
    durationMs: 0,
    optional: false,
    ok: report.ok,
    terminationConfirmed: true,
    stdout: redactVerifyOutput(detail),
    stderr: "",
  };
}

export async function runDeterministicVerify(
  manifest: RunManifest,
  runDir: string,
  attempt: ExecutionAttemptBinding = executionAttemptBinding(manifest.runId, 1, 0),
): Promise<VerifyRunResult> {
  mkdirSync(runDir, { recursive: true });
  const workbench = workbenchRoot();
  const profile = normalizeEvalProfile(manifest.evalProfile);
  const cwd =
    profile === "literature" || manifest.repoRoot === "juno-overseer"
      ? junoProjectRoot()
      : resolveRepoCwd(manifest, workbench);
  const preflight = safetyPreflightResult(workbench, manifest);
  if (preflight) {
    writeFileSync(path.join(runDir, "safety-verify.md"), `${preflight.stdout}\n`, "utf8");
    if (!preflight.ok) {
      return await runVerifySteps(manifest, runDir, cwd, [], [preflight], attempt);
    }
  }
  const initialResults = preflight ? [preflight] : [];
  if (profile === "literature") {
    return await runVerifySteps(
      manifest,
      runDir,
      cwd,
      verifyStepsForProfile(profile),
      [
        ...initialResults,
        ...artifactResults(literatureArtifactChecksForManifest(workbench, manifest)),
      ],
      attempt,
    );
  }
  if (manifest.repoRoot === "juno-overseer") {
    return await runVerifySteps(
      manifest,
      runDir,
      cwd,
      verifyStepsForProfile(profile),
      initialResults,
      attempt,
    );
  }
  return await runVerifySteps(
    manifest,
    runDir,
    cwd,
    [],
    [
      ...initialResults,
      ...artifactResults([
        {
          label: "Workbench package execution has an OS sandbox",
          ok: false,
          detail:
            "Refusing to execute Agent-generated package scripts on the host; configure an OS-level sandboxed verifier first",
        },
      ]),
    ],
    attempt,
  );
}
