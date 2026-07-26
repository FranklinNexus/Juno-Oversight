import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  estimateManifestTokens,
  recordApiFailure,
  recordApiSuccess,
  releaseApiSlot,
  resolveProviderId,
  waitForApiSlot,
} from "./api-gateway.js";
import { appendEvent, touchHeartbeat } from "./events.js";
import {
  EXECUTION_ARTIFACT_VERSION,
  evidenceSha256,
  executionAttemptBinding,
  manifestEvidenceSha256,
  type ExecutionAttemptBinding,
} from "./execution-artifact.js";
import { nowIso } from "./env.js";
import type { AgentExecutionContext, AgentExecutionResult } from "./executor.js";
import { agentCheckpointPathForRun, resolveRepoCwd } from "./manifest.js";
import { redactSensitiveText } from "./secret-redaction.js";
import type { RunManifest } from "./types.js";
import { resolveMissionDirectory } from "./workbench-paths.js";

interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(
    input: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
}

export interface CodexExecutorDependencies {
  createClient?: (options: CodexOptions) => CodexClientLike;
}

const SAFE_ENV_KEYS = [
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
  "ProgramFiles",
  "ProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "CODEX_HOME",
  "AGENT_WORKBENCH_ROOT",
  "JUNO_OVERSIGHT_ROOT",
] as const;

const AGENT_CHECKPOINT_MAX_BYTES = 1_000_000;

interface ValidatedCodexDirectories {
  agentOutput: string;
  mission?: string;
}

function atomicReplaceText(target: string, text: string): void {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temp, text, { encoding: "utf8", flag: "wx" });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

function assertExclusiveRegularFile(stat: BigIntStats, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  if (stat.nlink !== BigInt(1)) {
    throw new Error(`${label} must not be a hard link (link count ${stat.nlink})`);
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  // Node reports dev=0 for Windows path stats but the volume id for fstat handles.
  const devicesMatch =
    left.dev === right.dev || left.dev === BigInt(0) || right.dev === BigInt(0);
  return devicesMatch && left.ino === right.ino && left.nlink === right.nlink;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

function assertWritableTreeSafe(root: string, label: string): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = lstatSync(target, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${target}`);
      }
      if (stat.isDirectory()) {
        visit(target);
      } else if (stat.isFile() && stat.nlink !== BigInt(1)) {
        throw new Error(
          `${label} contains a hard-linked file: ${target} (link count ${stat.nlink})`,
        );
      }
    }
  };
  visit(root);
}

function assertCodexWritableTreesSafe(
  validatedDirectories: ValidatedCodexDirectories,
): void {
  assertWritableTreeSafe(validatedDirectories.agentOutput, "Agent output directory");
  if (validatedDirectories.mission) {
    assertWritableTreeSafe(validatedDirectories.mission, "Mission writable directory");
  }
}

export function buildCodexEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const entries = Object.entries(source);
  for (const wanted of SAFE_ENV_KEYS) {
    const found = entries.find(([key, value]) => key.toLowerCase() === wanted.toLowerCase() && value);
    if (found?.[1]) env[found[0]] = found[1];
  }
  return env;
}

export function buildCodexClientOptions(
  source: Readonly<Record<string, string | undefined>> = process.env,
): CodexOptions {
  const codexPathOverride = source.JUNO_CODEX_PATH?.trim();
  if (source.JUNO_PACKAGED_RUNTIME === "1" && !codexPathOverride) {
    throw new Error(
      "Packaged Juno requires an installed Codex CLI; set JUNO_CODEX_PATH to codex(.exe)",
    );
  }
  if (codexPathOverride && !existsSync(codexPathOverride)) {
    throw new Error(`Configured Codex CLI is unavailable: ${codexPathOverride}`);
  }
  return {
    env: buildCodexEnvironment(source),
    ...(codexPathOverride ? { codexPathOverride } : {}),
  };
}

function codexNetworkAllowed(manifest: RunManifest): boolean {
  return (manifest.allowedTools ?? []).some((tool) =>
    ["network", "web", "web_search"].includes(tool.toLowerCase()),
  );
}

export function buildCodexThreadOptions(
  manifest: RunManifest,
  workbench: string,
  runDir: string,
  validatedDirectories?: ValidatedCodexDirectories,
): ThreadOptions {
  const implement = (manifest.runKind ?? "implement") === "implement";
  const workingDirectory = resolveRepoCwd(manifest, workbench);
  const model = manifest.model && manifest.model !== "auto" ? manifest.model : undefined;
  const writableDirectories = [
    validatedDirectories?.agentOutput ?? path.join(runDir, "output"),
    ...(manifest.missionId
      ? [
          validatedDirectories?.mission
            ?? resolveMissionDirectory(workbench, manifest.missionId),
        ]
      : []),
  ].filter(
    (directory, index, all) =>
      path.resolve(directory) !== path.resolve(workingDirectory) &&
      all.findIndex((candidate) => path.resolve(candidate) === path.resolve(directory)) === index,
  );
  return {
    model,
    sandboxMode: implement ? "workspace-write" : "read-only",
    workingDirectory,
    skipGitRepoCheck: true,
    networkAccessEnabled: codexNetworkAllowed(manifest),
    webSearchMode: codexNetworkAllowed(manifest) ? "live" : "disabled",
    approvalPolicy: "never",
    additionalDirectories: implement ? writableDirectories : undefined,
  };
}

function validateContainedDirectory(root: string, target: string, label: string): string {
  const rootStat = lstatSync(root);
  const targetStat = lstatSync(target);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} root is not a regular directory: ${root}`);
  }
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory: ${target}`);
  }
  const canonicalRoot = realpathSync.native(root);
  const canonicalTarget = realpathSync.native(target);
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} escapes its trusted root: ${target}`);
  }
  return canonicalTarget;
}

function prepareCodexDirectories(
  manifest: RunManifest,
  workbench: string,
  runDir: string,
): ValidatedCodexDirectories {
  const runStat = lstatSync(runDir);
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
    throw new Error(`Run directory is not a regular directory: ${runDir}`);
  }
  const outputDir = path.join(runDir, "output");
  if (!existsSync(outputDir)) mkdirSync(outputDir);
  const agentOutput = validateContainedDirectory(runDir, outputDir, "Agent output directory");

  let mission: string | undefined;
  if (manifest.missionId) {
    const missionsRoot = path.join(workbench, "missions");
    const missionDirectory = resolveMissionDirectory(workbench, manifest.missionId);
    mission = validateContainedDirectory(
      missionsRoot,
      missionDirectory,
      "Mission writable directory",
    );
  }
  return { agentOutput, mission };
}

function removePreviousAgentCheckpoint(runDir: string): void {
  const checkpointPath = agentCheckpointPathForRun(runDir);
  if (!existsSync(checkpointPath)) return;
  const stat = lstatSync(checkpointPath, { bigint: true });
  assertExclusiveRegularFile(stat, "Previous agent checkpoint");
  rmSync(checkpointPath, { force: true });
}

function readAgentCheckpoint(
  runDir: string,
  validatedDirectories: ValidatedCodexDirectories,
): string {
  const outputDir = path.join(runDir, "output");
  const checkpointPath = agentCheckpointPathForRun(runDir);
  const outputStat = lstatSync(outputDir);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error("Agent output directory is not a regular directory");
  }
  assertCodexWritableTreesSafe(validatedDirectories);

  const checkpointStat = lstatSync(checkpointPath, { bigint: true });
  assertExclusiveRegularFile(checkpointStat, "Agent checkpoint");
  if (
    checkpointStat.size < BigInt(1)
    || checkpointStat.size > BigInt(AGENT_CHECKPOINT_MAX_BYTES)
  ) {
    throw new Error(
      `Agent checkpoint size must be between 1 and ${AGENT_CHECKPOINT_MAX_BYTES} bytes`,
    );
  }
  const canonicalOutput = realpathSync.native(outputDir);
  const canonicalCheckpoint = realpathSync.native(checkpointPath);
  if (path.dirname(canonicalCheckpoint) !== canonicalOutput) {
    throw new Error("Agent checkpoint escapes the output directory");
  }

  let descriptor: number | undefined;
  let raw: string;
  try {
    descriptor = openSync(canonicalCheckpoint, constants.O_RDONLY);
    const openedStat = fstatSync(descriptor, { bigint: true });
    assertExclusiveRegularFile(openedStat, "Opened agent checkpoint");
    if (!sameFileIdentity(checkpointStat, openedStat)) {
      throw new Error("Agent checkpoint identity changed while opening");
    }
    raw = readFileSync(descriptor, "utf8");
    const readStat = fstatSync(descriptor, { bigint: true });
    assertExclusiveRegularFile(readStat, "Read agent checkpoint");
    if (!sameFileSnapshot(openedStat, readStat)) {
      throw new Error("Agent checkpoint changed while being read");
    }
    const finalPathStat = lstatSync(canonicalCheckpoint, { bigint: true });
    assertExclusiveRegularFile(finalPathStat, "Final agent checkpoint");
    if (!sameFileSnapshot(readStat, finalPathStat)) {
      throw new Error("Agent checkpoint path changed while being read");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  const redacted = redactSensitiveText(raw);
  atomicReplaceText(canonicalCheckpoint, redacted);
  return redacted;
}

function appendCompletedItemEvent(eventsPath: string, event: ThreadEvent): string | undefined {
  if (event.type !== "item.completed") return undefined;
  const item = event.item;
  if (item.type === "agent_message") {
    const text = redactSensitiveText(item.text);
    appendEvent(eventsPath, { ts: nowIso(), type: "assistant", text });
    return text;
  }
  if (item.type === "command_execution") {
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "tool_call",
      tool: "shell",
      args: redactSensitiveText(item.command),
      ok: item.status === "completed" && item.exit_code === 0,
    });
  } else if (item.type === "file_change") {
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "tool_call",
      tool: "apply_patch",
      args: redactSensitiveText(
        item.changes.map((change) => `${change.kind}:${change.path}`).join(", "),
      ),
      ok: item.status === "completed",
    });
  } else if (item.type === "mcp_tool_call") {
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "tool_call",
      tool: `${item.server}/${item.tool}`,
      args: redactSensitiveText(JSON.stringify(item.arguments)).slice(0, 2_000),
      ok: item.status === "completed",
    });
  } else if (item.type === "error") {
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "error",
      message: redactSensitiveText(item.message),
    });
  }
  return undefined;
}

function writeCodexArtifact(
  manifest: RunManifest,
  runDir: string,
  eventsPath: string,
  attempt: ExecutionAttemptBinding,
  input: {
    threadId: string | null;
    ok: boolean;
    failure?: string;
    usage: Usage | null;
  },
): void {
  const checkpointPath = path.join(runDir, "checkpoint.md");
  const checkpointText = existsSync(checkpointPath) ? readFileSync(checkpointPath, "utf8") : null;
  const eventsText = readFileSync(eventsPath, "utf8");
  writeFileSync(
    path.join(runDir, "codex-artifact.json"),
    `${JSON.stringify(
      {
        version: EXECUTION_ARTIFACT_VERSION,
        runId: manifest.runId,
        ...attempt,
        threadId: input.threadId,
        model: manifest.model ?? "default",
        completedAt: nowIso(),
        ok: input.ok,
        failure: input.failure,
        usage: input.usage,
        manifestSha256: manifestEvidenceSha256(manifest),
        checkpointSha256: checkpointText === null ? null : evidenceSha256(checkpointText),
        eventsSha256: evidenceSha256(eventsText),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function runCodexExecutor(
  context: AgentExecutionContext,
  dependencies: CodexExecutorDependencies = {},
): Promise<AgentExecutionResult> {
  const { manifest, workbench, runDir, prompt } = context;
  const attempt = context.attempt ?? executionAttemptBinding(manifest.runId, 1, 0);
  mkdirSync(runDir, { recursive: true });
  const eventsPath = path.join(runDir, "events.jsonl");
  const providerId = resolveProviderId(manifest);
  const estimatedTokens = estimateManifestTokens(manifest);
  const started = Date.now();
  const maxRuntimeMs = Math.max(1, manifest.maxMinutes) * 60_000;

  appendEvent(eventsPath, {
    ts: nowIso(),
    type: "status",
    status: "starting",
    detail: `openai_codex:${manifest.model ?? "default"}; quota=${providerId}`,
    ...attempt,
  });
  touchHeartbeat(runDir);

  const prepared = (() => {
    try {
      const validatedDirectories = prepareCodexDirectories(manifest, workbench, runDir);
      if ((manifest.runKind ?? "implement") === "implement") {
        removePreviousAgentCheckpoint(runDir);
        assertCodexWritableTreesSafe(validatedDirectories);
      }
      const threadOptions = buildCodexThreadOptions(
        manifest,
        workbench,
        runDir,
        validatedDirectories,
      );
      const workingDirectory = resolveRepoCwd(manifest, workbench);
      mkdirSync(workingDirectory, { recursive: true });
      return {
        validatedDirectories,
        threadOptions,
        clientOptions: buildCodexClientOptions(),
      };
    } catch (error) {
      const failure = redactSensitiveText(
        `Codex setup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      appendEvent(eventsPath, { ts: nowIso(), type: "error", message: failure });
      appendEvent(eventsPath, {
        ts: nowIso(),
        type: "finished",
        status: "error",
        result: failure,
        model: manifest.model ?? "codex-default",
      });
      writeCodexArtifact(manifest, runDir, eventsPath, attempt, {
        threadId: null,
        ok: false,
        failure,
        usage: null,
      });
      throw error;
    }
  })();
  const { validatedDirectories, threadOptions, clientOptions } = prepared;
  const createClient = dependencies.createClient ?? ((options) => new Codex(options));
  const heartbeat = setInterval(() => {
    try {
      touchHeartbeat(runDir);
    } catch {
      /* The streamed event path will fail closed on its next write. */
    }
  }, 30_000);

  let gate;
  try {
    gate = await waitForApiSlot(workbench, providerId, {
      estimatedTokens,
      maxWaitMs: maxRuntimeMs,
      leaseMs: maxRuntimeMs + 60_000,
    });
  } catch (error) {
    clearInterval(heartbeat);
    const failure = redactSensitiveText(
      `Provider gate error: ${error instanceof Error ? error.message : String(error)}`,
    );
    appendEvent(eventsPath, { ts: nowIso(), type: "error", message: failure });
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "finished",
      status: "error",
      result: failure,
      model: manifest.model ?? "codex-default",
    });
    writeCodexArtifact(manifest, runDir, eventsPath, attempt, {
      threadId: null,
      ok: false,
      failure,
      usage: null,
    });
    return { ok: false, text: failure };
  }
  if (!gate.ok) {
    clearInterval(heartbeat);
    const failure = `Provider gate blocked: ${gate.reason ?? "unknown"}`;
    appendEvent(eventsPath, { ts: nowIso(), type: "error", message: failure });
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "finished",
      status: "error",
      result: failure,
      model: manifest.model ?? "codex-default",
    });
    writeCodexArtifact(manifest, runDir, eventsPath, attempt, {
      threadId: null,
      ok: false,
      failure,
      usage: null,
    });
    return { ok: false, text: failure };
  }

  const controller = new AbortController();
  const remainingMs = Math.max(1, maxRuntimeMs - (Date.now() - started));
  const timeout = setTimeout(
    () => controller.abort(new Error(`Codex slot exceeded ${manifest.maxMinutes} minutes`)),
    remainingMs,
  );
  let finalText = "";
  let failure = "";
  let completed = false;
  let usage: Usage | null = null;
  let thread: CodexThreadLike | undefined;
  let leaseReleaseFailure = "";

  try {
    const client = createClient(clientOptions);
    thread = client.startThread(threadOptions);
    const streamed = await thread.runStreamed(prompt, { signal: controller.signal });
    for await (const event of streamed.events) {
      touchHeartbeat(runDir);
      if (event.type === "thread.started") {
        appendEvent(eventsPath, {
          ts: nowIso(),
          type: "status",
          status: "codex_thread_started",
          detail: event.thread_id,
        });
      } else if (event.type === "turn.failed") {
        failure = redactSensitiveText(event.error.message);
      } else if (event.type === "error") {
        failure = redactSensitiveText(event.message);
      } else if (event.type === "turn.completed") {
        completed = true;
        usage = event.usage;
      }
      finalText = appendCompletedItemEvent(eventsPath, event) ?? finalText;
    }
  } catch (error) {
    failure = redactSensitiveText(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    try {
      releaseApiSlot(workbench, providerId, gate.leaseId);
    } catch (error) {
      leaseReleaseFailure = redactSensitiveText(
        `Provider lease release failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (leaseReleaseFailure) failure = failure || leaseReleaseFailure;
  if (!failure && !completed) failure = "Codex stream ended without turn.completed";
  if (!failure && !finalText.trim()) failure = "Codex returned no final response";
  let trustedImplementCheckpoint: string | null = null;
  if (!failure && (manifest.runKind ?? "implement") === "implement") {
    try {
      trustedImplementCheckpoint = readAgentCheckpoint(runDir, validatedDirectories);
      if (!trustedImplementCheckpoint.trim()) throw new Error("Agent checkpoint is empty");
    } catch (error) {
      failure = redactSensitiveText(
        `Invalid or missing agent checkpoint: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const ok = !failure && finalText.trim().length > 0;
  if (ok) {
    const tokens = usage ? usage.input_tokens + usage.output_tokens : undefined;
    recordApiSuccess(workbench, providerId, {
      tokens,
      latencyMs: Date.now() - started,
      requestId: gate.leaseId,
    });
  } else {
    recordApiFailure(workbench, providerId, {
      retryable: true,
      message: failure || "Codex returned no final response",
    });
  }
  if (ok && trustedImplementCheckpoint !== null) {
    atomicReplaceText(
      path.join(runDir, "checkpoint.md"),
      `${trustedImplementCheckpoint.trim()}\n`,
    );
  } else if (
    ok
    && (manifest.runKind ?? "implement") !== "implement"
    && finalText.trim()
  ) {
    atomicReplaceText(path.join(runDir, "checkpoint.md"), `${finalText.trim()}\n`);
  }
  if (failure) {
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "error",
      message: redactSensitiveText(failure),
    });
  }
  appendEvent(eventsPath, {
    ts: nowIso(),
    type: "finished",
    status: ok ? "finished" : "error",
    result: redactSensitiveText(
      ok ? finalText.slice(0, 8_000) : failure || "Codex returned no final response",
    ),
    model: manifest.model ?? "codex-default",
  });
  writeCodexArtifact(manifest, runDir, eventsPath, attempt, {
    threadId: thread?.id ?? null,
    ok,
    failure: failure ? redactSensitiveText(failure) : undefined,
    usage,
  });
  return {
    ok,
    text: redactSensitiveText(ok ? finalText : failure || finalText),
  };
}
