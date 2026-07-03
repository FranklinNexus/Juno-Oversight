import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Agent, CursorAgentError } from "@cursor/sdk";
import { runApiToken } from "./api-token.js";
import {
  estimateManifestTokens,
  recordApiFailure,
  recordApiSuccess,
  releaseApiSlot,
  resolveProviderId,
  waitForApiSlot,
} from "./api-gateway.js";
import { appendEvent, touchHeartbeat } from "./events.js";
import { junoProjectRoot, loadProjectEnv, nowIso, workbenchRoot } from "./env.js";
import {
  buildUserPrompt,
  loadRunState,
  readJsonFile,
  saveRunState,
} from "./manifest.js";
import { writeMcpHints } from "./mcp-config.js";
import { composerFallbackChain } from "./model-defaults.js";
import type { RunManifest } from "./types.js";

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

function updateOrchestrator(workbench: string, runId: string, status: string): void {
  const statePath = path.join(workbench, "state", "orchestrator.json");
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  } catch {
    state = {};
  }
  state.activeRunId = runId;
  state.activeRunStatus = status;
  state.lastRunId = runId;
  state.updatedAt = nowIso();
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function runDryRun(manifest: RunManifest, workbench: string, runDir: string): Promise<void> {
  const eventsPath = path.join(runDir, "events.jsonl");
  const targetDir = path.resolve(workbench, manifest.cwd);
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

async function runComposerStreaming(
  manifest: RunManifest,
  workbench: string,
  runDir: string,
  prompt: string,
): Promise<{ ok: boolean; text: string }> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey?.trim()) throw new Error("CURSOR_API_KEY is not set");

  const providerId = resolveProviderId(manifest);
  const estimatedTokens = estimateManifestTokens(manifest);
  const started = Date.now();

  const gate = await waitForApiSlot(workbench, providerId, {
    estimatedTokens,
    maxWaitMs: 900_000,
  });
  if (!gate.ok) {
    return { ok: false, text: `API gateway blocked (${gate.reason}) — retry later` };
  }

  const cwd =
    manifest.repoRoot === "juno-overseer" ? junoProjectRoot() : workbench;
  mkdirSync(path.resolve(cwd, manifest.cwd === "." ? "" : manifest.cwd), {
    recursive: true,
  });
  const mcpHints = writeMcpHints(workbench, {
    missionId: manifest.missionId,
    repoRoot: manifest.repoRoot,
    provider: manifest.provider,
  });
  const eventsPath = path.join(runDir, "events.jsonl");
  const modelId = manifest.model ?? "auto";

  appendEvent(eventsPath, {
    ts: nowIso(),
    type: "status",
    status: "starting",
    detail: `${modelId} via api-gateway:${providerId}; mcp=[${mcpHints.enabledServers.map((s) => s.id).join(",")}]`,
  });
  updateOrchestrator(workbench, manifest.runId, "running");

  const heartbeat = setInterval(() => touchHeartbeat(runDir), 30_000);
  touchHeartbeat(runDir);

  try {
    await using agent = await Agent.create({
      apiKey,
      model: { id: modelId },
      local: { cwd, settingSources: ["project"] },
    });

    const run = await agent.send(prompt);
    let streamed = "";

    for await (const event of run.stream()) {
      touchHeartbeat(runDir);
      if (event.type !== "assistant") continue;
      for (const block of event.message.content) {
        if (block.type !== "text" || !block.text) continue;
        streamed += block.text;
        appendEvent(eventsPath, {
          ts: nowIso(),
          type: "assistant",
          text: block.text,
          partial: true,
        });
      }
    }

    const result = await run.wait();
    if (result.status === "error") {
      const errText = (result.result ?? streamed ?? "").slice(0, 2000) || "(empty error from API)";
      appendEvent(eventsPath, {
        ts: nowIso(),
        type: "finished",
        status: "error",
        result: errText,
        model: modelId,
      });
      recordApiFailure(workbench, providerId, { retryable: true, message: errText });
      return { ok: false, text: errText };
    }

    const finalText = result.result ?? streamed;
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "finished",
      status: "finished",
      result: finalText.slice(0, 8000),
      model: modelId,
    });
    recordApiSuccess(workbench, providerId, {
      tokens: estimatedTokens,
      latencyMs: Date.now() - started,
    });
    return { ok: true, text: finalText };
  } catch (err: unknown) {
    if (err instanceof CursorAgentError) {
      recordApiFailure(workbench, providerId, {
        retryable: err.isRetryable,
        message: err.message,
      });
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
    releaseApiSlot(workbench, providerId);
  }
}

async function runSlot(manifest: RunManifest, workbench: string, runDir: string): Promise<void> {
  const runState = loadRunState(runDir);
  runState.slotIndex += 1;
  runState.updatedAt = nowIso();
  saveRunState(runDir, runState);

  const prompt = buildUserPrompt(manifest, workbench, runDir, runState);
  let ok = false;

  if (manifest.provider === "api_token") {
    const result = await runApiToken(manifest, workbench, runDir, prompt);
    ok = result.ok;
  } else if (manifest.provider === "cursor_composer") {
    const chain = composerFallbackChain(workbench);
    const primary = manifest.model ?? chain[0] ?? "auto";
    const models = [primary, ...chain.filter((m) => m !== primary)];
    let lastText = "";
    try {
      for (const modelId of models) {
        appendEvent(path.join(runDir, "events.jsonl"), {
          ts: nowIso(),
          type: "status",
          status: "model_try",
          detail: modelId,
        });
        const attemptManifest = { ...manifest, model: modelId };
        const result = await runComposerStreaming(attemptManifest, workbench, runDir, prompt);
        if (result.ok) {
          ok = true;
          break;
        }
        lastText = result.text;
        if (result.text.includes("API gateway blocked")) {
          break;
        }
      }
      if (!ok && lastText) {
        appendEvent(path.join(runDir, "events.jsonl"), {
          ts: nowIso(),
          type: "error",
          message: `all models failed; last: ${lastText.slice(0, 500)}`,
        });
      }
    } catch (err: unknown) {
      const eventsPath = path.join(runDir, "events.jsonl");
      if (err instanceof CursorAgentError) {
        appendEvent(eventsPath, {
          ts: nowIso(),
          type: "error",
          message: err.message,
          retryable: err.isRetryable,
        });
        updateOrchestrator(workbench, manifest.runId, "failed");
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  } else {
    throw new Error(`Unknown provider: ${manifest.provider}`);
  }

  runState.lastStatus = ok ? "done" : "failed";
  runState.updatedAt = nowIso();
  saveRunState(runDir, runState);
  updateOrchestrator(workbench, manifest.runId, ok ? "done" : "failed");
  if (!ok) process.exitCode = 2;
}

async function main(): Promise<void> {
  loadProjectEnv();
  const { manifestPath, dryRun } = parseArgs(process.argv.slice(2));
  const manifest = readJsonFile<RunManifest>(manifestPath);
  const workbench = workbenchRoot();
  const runDir = path.dirname(manifestPath);

  if (dryRun) {
    await runDryRun(manifest, workbench, runDir);
    return;
  }

  await runSlot(manifest, workbench, runDir);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
