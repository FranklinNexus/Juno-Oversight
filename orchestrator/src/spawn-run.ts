import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, touchHeartbeat } from "./events.js";
import {
  executionAttemptBinding,
  finalizeExecutionFailureArtifact,
  type ExecutionAttemptBinding,
} from "./execution-artifact.js";
import { runCodexExecutor } from "./codex-executor.js";
import {
  readExclusiveControlText,
  type ControlFileReadHooks,
} from "./control-file.js";
import { resolveAgentExecutor, type AgentExecutor } from "./executor.js";
import { loadProjectEnv, nowIso, workbenchRoot } from "./env.js";
import {
  normalizeRunStatus,
  readOrchestratorState,
  type OrchestratorRunStatus,
  writeOrchestratorState,
} from "./idempotency.js";
import {
  buildUserPrompt,
  canonicalizeRunManifest,
  loadRunState,
  resolveRepoCwd,
  saveRunState,
  validateRunManifestControlFields,
} from "./manifest.js";
import { runDeterministicVerify } from "./verify-runner.js";
import {
  acquireRunSlotLease,
  releaseRunSlotLease,
  type RunSlotLease,
} from "./run-slot-lock.js";
import { redactSensitiveText } from "./secret-redaction.js";
import type { RunManifest, RunState } from "./types.js";
import {
  assertRunManifestId,
  validateRunManifestPath,
  type ValidatedRunManifestPath,
} from "./workbench-paths.js";

export interface ManifestControlGuard {
  manifestPath: string;
  fingerprint: string;
  assertUnchangedAndRestore(): void;
}

export interface RunSlotDependencies {
  buildPrompt?: typeof buildUserPrompt;
  runVerify?: typeof runDeterministicVerify;
  runAgent?: AgentExecutor;
}

export interface RunSlotOptions {
  dependencies?: RunSlotDependencies;
  manifestControl?: ManifestControlGuard;
}

export const RUN_BUSY_EXIT_CODE = 4;
export const MAX_RUN_MANIFEST_BYTES = 256 * 1024;

export interface TrustedRunManifest {
  location: ValidatedRunManifestPath;
  manifest: RunManifest;
}

export function acquireRequiredRunSlotLease(runDir: string, runId: string): RunSlotLease {
  const lease = acquireRunSlotLease(runDir);
  if (lease) return lease;
  process.exitCode = RUN_BUSY_EXIT_CODE;
  throw new Error(`Run slot is already active: ${runId}`);
}

function parseArgs(argv: string[]): { manifestPath: string; dryRun: boolean } {
  const idx = argv.indexOf("--manifest");
  if (idx === -1 || !argv[idx + 1]) {
    throw new Error("Usage: spawn-run.js --manifest <path> [--dry-run]");
  }
  return { manifestPath: argv[idx + 1], dryRun: argv.includes("--dry-run") };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateOrchestrator(
  workbench: string,
  runId: string,
  status: OrchestratorRunStatus,
): void {
  writeOrchestratorState(workbench, runId, status);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function atomicReplaceText(target: string, text: string): void {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: "utf8", flag: "wx" });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

function manifestFileMatches(target: string, fingerprint: string): boolean {
  try {
    return (
      readExclusiveControlText(
        target,
        "Run manifest",
        MAX_RUN_MANIFEST_BYTES,
      ).sha256 === fingerprint
    );
  } catch {
    return false;
  }
}

function assertSameManifestLocation(
  expected: ValidatedRunManifestPath,
  actual: ValidatedRunManifestPath,
): void {
  if (
    actual.manifestPath !== expected.manifestPath ||
    actual.runDir !== expected.runDir ||
    actual.runId !== expected.runId
  ) {
    throw new Error(`Run manifest location changed while reading: ${expected.manifestPath}`);
  }
}

function parseManifestText(text: string, target: string): unknown {
  const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid run manifest JSON: ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/** Bind one bounded descriptor read to the canonical run directory and manifest id. */
export function readTrustedRunManifest(
  workbench: string,
  suppliedManifestPath: string,
  hooks: ControlFileReadHooks = {},
): TrustedRunManifest {
  const beforeRead = validateRunManifestPath(workbench, suppliedManifestPath);
  const snapshot = readExclusiveControlText(
    beforeRead.manifestPath,
    "Run manifest",
    MAX_RUN_MANIFEST_BYTES,
    hooks,
  );

  const beforeParse = validateRunManifestPath(workbench, beforeRead.manifestPath);
  assertSameManifestLocation(beforeRead, beforeParse);
  const parsed = parseManifestText(snapshot.text, beforeParse.manifestPath);
  assertRunManifestId(
    beforeParse,
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).runId
      : undefined,
  );
  const manifest = validateRunManifestControlFields(
    canonicalizeRunManifest(parsed as RunManifest, workbench),
    workbench,
  );

  const afterParse = validateRunManifestPath(workbench, beforeParse.manifestPath);
  assertSameManifestLocation(beforeParse, afterParse);
  assertRunManifestId(afterParse, manifest.runId);
  return { location: afterParse, manifest };
}

export function createManifestControlGuard(
  manifestPath: string,
  manifest: RunManifest,
): ManifestControlGuard {
  const trustedText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(trustedText, "utf8") > MAX_RUN_MANIFEST_BYTES) {
    throw new Error(
      `Canonical run manifest exceeds the ${MAX_RUN_MANIFEST_BYTES}-byte limit: ${manifestPath}`,
    );
  }
  const fingerprint = hashText(trustedText);
  atomicReplaceText(manifestPath, trustedText);
  return {
    manifestPath,
    fingerprint,
    assertUnchangedAndRestore(): void {
      if (manifestFileMatches(manifestPath, fingerprint)) return;
      atomicReplaceText(manifestPath, trustedText);
      if (!manifestFileMatches(manifestPath, fingerprint)) {
        throw new Error(`Run manifest control drift could not be restored: ${manifestPath}`);
      }
      throw new Error(`Run manifest control drift detected and restored: ${manifestPath}`);
    },
  };
}

function blocked(status: string | null | undefined): boolean {
  return normalizeRunStatus(status) === "blocked";
}

function orchestratorBlocksRun(
  orchestrator: ReturnType<typeof readOrchestratorState> | undefined,
  runId: string,
): boolean {
  return orchestrator?.activeRunId === runId && blocked(orchestrator.activeRunStatus);
}

interface SlotSettlement {
  status: "done" | "failed" | "blocked";
  errors: string[];
}

function settleSlotStatus(
  workbench: string,
  runId: string,
  runDir: string,
  fallbackState: RunState | undefined,
  desired: "done" | "failed",
): SlotSettlement {
  const errors: string[] = [];
  let state: RunState | undefined;
  let orchestrator: ReturnType<typeof readOrchestratorState> | undefined;
  try {
    state = loadRunState(runDir);
    if (
      fallbackState &&
      (state.slotIndex !== fallbackState.slotIndex ||
        state.retryCount !== fallbackState.retryCount)
    ) {
      errors.push("run-state execution attempt binding changed during slot execution");
      state = {
        ...state,
        slotIndex: fallbackState.slotIndex,
        retryCount: fallbackState.retryCount,
      };
    }
  } catch (error) {
    if (fallbackState) state = { ...fallbackState };
    else errors.push(`run-state read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    orchestrator = readOrchestratorState(workbench);
  } catch (error) {
    errors.push(
      `orchestrator state read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const terminalBlocked = blocked(state?.lastStatus) || orchestratorBlocksRun(orchestrator, runId);
  const status = terminalBlocked ? "blocked" : desired;
  if (state) {
    try {
      saveRunState(runDir, { ...state, lastStatus: status, updatedAt: nowIso() });
    } catch (error) {
      errors.push(
        `run-state ${status} persistence failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (orchestrator) {
    try {
      if (!orchestratorBlocksRun(orchestrator, runId)) {
        updateOrchestrator(workbench, runId, status);
      }
    } catch (error) {
      errors.push(
        `orchestrator ${status} persistence failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return { status, errors };
}

function appendFailureEvent(
  runDir: string,
  manifest: RunManifest,
  attempt: ExecutionAttemptBinding | undefined,
  message: string,
): void {
  // Without a persisted slot there is no new execution attempt to bind. Appending
  // would only invalidate evidence from the previous completed attempt.
  if (!attempt) return;
  try {
    const eventsPath = path.join(runDir, "events.jsonl");
    const safeMessage = redactSensitiveText(message);
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "status",
      status: manifest.runKind === "verify" ? "verify_starting" : "starting",
      detail: "spawn settlement failure",
      ...attempt,
    });
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "error",
      message: safeMessage,
    });
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "finished",
      status: "error",
      result: safeMessage,
      model: manifest.runKind === "verify" ? "deterministic" : manifest.model ?? "codex-default",
    });
    finalizeExecutionFailureArtifact(manifest, runDir, attempt, safeMessage);
  } catch {
    // State settlement remains authoritative when event persistence is unavailable.
  }
}

async function runDryRun(manifest: RunManifest, workbench: string, runDir: string): Promise<void> {
  const eventsPath = path.join(runDir, "events.jsonl");
  const targetDir = resolveRepoCwd(manifest, workbench);
  mkdirSync(targetDir, { recursive: true });
  appendEvent(eventsPath, { ts: nowIso(), type: "status", status: "starting", detail: "dry-run" });
  updateOrchestrator(workbench, manifest.runId, "running");
  touchHeartbeat(runDir);
  await sleep(300);
  appendEvent(eventsPath, {
    ts: nowIso(),
    type: "assistant",
    text: "Dry-run slot complete.",
  });
  appendEvent(eventsPath, {
    ts: nowIso(),
    type: "finished",
    status: "finished",
    result: "dry-run ok",
  });
  updateOrchestrator(workbench, manifest.runId, "done");
}

export async function runSlot(
  manifest: RunManifest,
  workbench: string,
  runDir: string,
  options: RunSlotOptions = {},
): Promise<void> {
  let trustedState: RunState | undefined;
  let attempt: ExecutionAttemptBinding | undefined;
  let controlChecked = false;
  const checkManifestControl = (): void => {
    if (controlChecked) return;
    controlChecked = true;
    options.manifestControl?.assertUnchangedAndRestore();
  };

  try {
    const runState = loadRunState(runDir);
    trustedState = { ...runState };
    const orchestrator = readOrchestratorState(workbench);
    if (blocked(runState.lastStatus) || orchestratorBlocksRun(orchestrator, manifest.runId)) {
      throw new Error(`Run ${manifest.runId} is terminally blocked`);
    }

    runState.slotIndex += 1;
    runState.lastStatus = "running";
    runState.updatedAt = nowIso();
    saveRunState(runDir, runState);
    trustedState = { ...runState };
    attempt = executionAttemptBinding(manifest.runId, runState.slotIndex, runState.retryCount);
    updateOrchestrator(workbench, manifest.runId, "running");

    let ok: boolean;
    if (manifest.runKind === "verify") {
      ok = (await (options.dependencies?.runVerify ?? runDeterministicVerify)(
        manifest,
        runDir,
        attempt,
      )).ok;
    } else {
      const prompt = (options.dependencies?.buildPrompt ?? buildUserPrompt)(
        manifest,
        workbench,
        runDir,
        runState,
      );
      const executor =
        options.dependencies?.runAgent ??
        resolveAgentExecutor(manifest.provider, {
          openai_codex: (context) => runCodexExecutor(context),
        });
      ok = (await executor({ manifest, workbench, runDir, prompt, attempt })).ok;
    }

    checkManifestControl();
    const settlement = settleSlotStatus(
      workbench,
      manifest.runId,
      runDir,
      trustedState,
      ok ? "done" : "failed",
    );
    if (settlement.errors.length > 0) throw new Error(settlement.errors.join("; "));
    if (settlement.status === "blocked") process.exitCode = 5;
    else if (!ok) process.exitCode = 2;
  } catch (error) {
    const failures = [error instanceof Error ? error.message : String(error)];
    try {
      checkManifestControl();
    } catch (controlError) {
      failures.push(controlError instanceof Error ? controlError.message : String(controlError));
    }
    const settlement = settleSlotStatus(
      workbench,
      manifest.runId,
      runDir,
      trustedState,
      "failed",
    );
    failures.push(...settlement.errors);
    const message = redactSensitiveText(failures.join("; "));
    appendFailureEvent(runDir, manifest, attempt, message);
    process.exitCode = settlement.status === "blocked" ? 5 : 1;
    throw new Error(message, { cause: error });
  }
}

export async function main(): Promise<void> {
  loadProjectEnv();
  const { manifestPath: suppliedManifestPath, dryRun } = parseArgs(process.argv.slice(2));
  const workbench = workbenchRoot();
  const initialLocation = validateRunManifestPath(workbench, suppliedManifestPath);
  const lease = acquireRequiredRunSlotLease(initialLocation.runDir, initialLocation.runId);

  let failure: unknown;
  try {
    const trusted = readTrustedRunManifest(workbench, initialLocation.manifestPath);
    const { location, manifest } = trusted;
    if (location.runDir !== initialLocation.runDir) {
      throw new Error(`Run manifest location changed after lock acquisition: ${location.manifestPath}`);
    }
    assertRunManifestId(initialLocation, manifest.runId);
    assertRunManifestId(location, manifest.runId);
    const manifestControl = createManifestControlGuard(location.manifestPath, manifest);

    if (dryRun) {
      await runDryRun(manifest, workbench, location.runDir);
      manifestControl.assertUnchangedAndRestore();
    } else {
      await runSlot(manifest, workbench, location.runDir, { manifestControl });
    }
  } catch (error) {
    failure = error;
  } finally {
    if (!releaseRunSlotLease(lease)) {
      const releaseError = new Error(`Lost run-slot lease ownership: ${lease.lockPath}`);
      failure = failure
        ? new AggregateError([failure, releaseError], "Run failed and its lease ownership was lost")
        : releaseError;
    }
  }
  if (failure) throw failure;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && path.resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  void main().catch((err: unknown) => {
    const message = redactSensitiveText(err instanceof Error ? err.message : String(err));
    process.stderr.write(`${message}\n`);
    process.exitCode ||= 1;
  });
}
