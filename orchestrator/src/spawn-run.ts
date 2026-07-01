import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Agent, CursorAgentError } from "@cursor/sdk";
import { runApiToken } from "./api-token.js";
import { appendEvent, touchHeartbeat } from "./events.js";
import { loadProjectEnv, nowIso, workbenchRoot } from "./env.js";
import {
  buildUserPrompt,
  loadRunState,
  readJsonFile,
  saveRunState,
} from "./manifest.js";
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

  const cwd = workbench;
  mkdirSync(path.resolve(workbench, manifest.cwd), { recursive: true });
  const eventsPath = path.join(runDir, "events.jsonl");
  const modelId = manifest.model ?? "composer-2.5";

  appendEvent(eventsPath, { ts: nowIso(), type: "status", status: "starting", detail: modelId });
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
      appendEvent(eventsPath, {
        ts: nowIso(),
        type: "finished",
        status: "error",
        result: result.result,
      });
      return { ok: false, text: result.result ?? streamed };
    }

    const finalText = result.result ?? streamed;
    appendEvent(eventsPath, {
      ts: nowIso(),
      type: "finished",
      status: "finished",
      result: finalText.slice(0, 8000),
    });
    return { ok: true, text: finalText };
  } finally {
    clearInterval(heartbeat);
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
    try {
      const result = await runComposerStreaming(manifest, workbench, runDir, prompt);
      ok = result.ok;
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
