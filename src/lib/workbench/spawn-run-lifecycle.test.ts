import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireRequiredRunSlotLease,
  createManifestControlGuard,
  RUN_BUSY_EXIT_CODE,
  runSlot,
} from "../../../orchestrator/src/spawn-run.js";
import {
  EXECUTION_ARTIFACT_VERSION,
  evidenceSha256,
  executionAttemptBinding,
} from "../../../orchestrator/src/execution-artifact.js";
import { readOrchestratorState, writeOrchestratorState } from "../../../orchestrator/src/idempotency.js";
import { loadRunState, saveRunState } from "../../../orchestrator/src/manifest.js";
import { acquireRunSlotLease, releaseRunSlotLease } from "../../../orchestrator/src/run-slot-lock.js";
import type { RunManifest, RunState } from "../../../orchestrator/src/types.js";

function fixture(runId: string): {
  workbench: string;
  runDir: string;
  manifest: RunManifest;
  initialState: RunState;
} {
  const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-spawn-lifecycle-"));
  const runDir = path.join(workbench, "runs", runId);
  mkdirSync(path.join(workbench, "state"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const initialState: RunState = { retryCount: 0, slotIndex: 0, maxRetries: 3 };
  saveRunState(runDir, initialState);
  return {
    workbench,
    runDir,
    initialState,
    manifest: {
      runId,
      horizon: "mission",
      runKind: "review",
      repoRoot: "juno-overseer",
      provider: "openai_codex",
      promptTemplate: "executor_review",
      cwd: ".",
      maxMinutes: 1,
      maxRetries: 3,
    },
  };
}

async function withExitCodeRestored(run: () => Promise<void>): Promise<void> {
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    await run();
  } finally {
    process.exitCode = previous;
  }
}

describe("spawn-run slot lifecycle", () => {
  it("settles run-state and orchestrator to failed when slot setup throws", async () => {
    const { workbench, runDir, manifest } = fixture("setup-error");
    mkdirSync(path.join(runDir, "checkpoint.md"));
    await withExitCodeRestored(async () => {
      await expect(
        runSlot(manifest, workbench, runDir, {
          dependencies: {
            buildPrompt: () => {
              throw new Error("injected setup failure");
            },
          },
        }),
      ).rejects.toThrow(/injected setup failure/);
      expect(process.exitCode).toBe(1);
    });

    expect(loadRunState(runDir)).toMatchObject({ slotIndex: 1, lastStatus: "failed" });
    expect(readOrchestratorState(workbench)).toMatchObject({
      activeRunId: manifest.runId,
      activeRunStatus: "failed",
    });
    const eventsText = readFileSync(path.join(runDir, "events.jsonl"), "utf8");
    expect(JSON.parse(readFileSync(path.join(runDir, "codex-artifact.json"), "utf8")))
      .toMatchObject({
        version: EXECUTION_ARTIFACT_VERSION,
        checkpointSha256: null,
        ok: false,
        eventsSha256: evidenceSha256(eventsText),
      });
  });

  it("preserves a terminal blocked state when execution is attempted", async () => {
    const { workbench, runDir, manifest, initialState } = fixture("already-blocked");
    const priorEvents = `${JSON.stringify({
      ts: "2026-07-15T00:00:00.000Z",
      type: "finished",
      status: "finished",
    })}\n`;
    writeFileSync(path.join(runDir, "events.jsonl"), priorEvents, "utf8");
    saveRunState(runDir, { ...initialState, lastStatus: "blocked" });
    writeOrchestratorState(workbench, manifest.runId, "blocked");

    await withExitCodeRestored(async () => {
      await expect(runSlot(manifest, workbench, runDir)).rejects.toThrow(/terminally blocked/);
      expect(process.exitCode).toBe(5);
    });
    expect(loadRunState(runDir)).toMatchObject({ slotIndex: 0, lastStatus: "blocked" });
    expect(readOrchestratorState(workbench).activeRunStatus).toBe("blocked");
    expect(readFileSync(path.join(runDir, "events.jsonl"), "utf8")).toBe(priorEvents);
  });

  it("does not treat a foreign stale orchestrator block as terminal", async () => {
    const { workbench, runDir, manifest } = fixture("current-run");
    writeOrchestratorState(workbench, "foreign-run", "blocked");

    await withExitCodeRestored(async () => {
      await runSlot(manifest, workbench, runDir, {
        dependencies: {
          buildPrompt: () => "test prompt",
          runAgent: async () => ({ ok: true, text: "done" }),
        },
      });
      expect(process.exitCode).toBeUndefined();
    });

    expect(loadRunState(runDir)).toMatchObject({ slotIndex: 1, lastStatus: "done" });
    expect(readOrchestratorState(workbench)).toMatchObject({
      activeRunId: manifest.runId,
      activeRunStatus: "done",
    });
  });

  it("reports a busy slot as no-progress without touching run-state", async () => {
    const { runDir, manifest, initialState } = fixture("busy-run");
    const held = acquireRunSlotLease(runDir)!;
    try {
      await withExitCodeRestored(async () => {
        expect(() => acquireRequiredRunSlotLease(runDir, manifest.runId)).toThrow(/already active/);
        expect(process.exitCode).toBe(RUN_BUSY_EXIT_CODE);
      });
      expect(loadRunState(runDir)).toEqual(initialState);
    } finally {
      expect(releaseRunSlotLease(held)).toBe(true);
    }
  });

  it("restores a modified manifest and forces the slot to fail", async () => {
    const { workbench, runDir, manifest } = fixture("manifest-drift");
    const manifestPath = path.join(runDir, "manifest.json");
    const guard = createManifestControlGuard(manifestPath, manifest);

    await withExitCodeRestored(async () => {
      await expect(
        runSlot(manifest, workbench, runDir, {
          manifestControl: guard,
          dependencies: {
            buildPrompt: () => "test prompt",
            runAgent: async () => {
              writeFileSync(
                path.join(runDir, "codex-artifact.json"),
                `${JSON.stringify({
                  threadId: "stale-success-thread",
                  usage: { input_tokens: 99 },
                  ok: true,
                })}\n`,
                "utf8",
              );
              const tampered = { ...manifest, maxMinutes: 240, allowedTools: ["network"] };
              writeFileSync(manifestPath, JSON.stringify(tampered), "utf8");
              return { ok: true, text: "done" };
            },
          },
        }),
      ).rejects.toThrow(/control drift detected and restored/);
      expect(process.exitCode).toBe(1);
    });

    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual(manifest);
    expect(loadRunState(runDir).lastStatus).toBe("failed");
    expect(readOrchestratorState(workbench).activeRunStatus).toBe("failed");
    const eventsText = readFileSync(path.join(runDir, "events.jsonl"), "utf8");
    expect(JSON.parse(readFileSync(path.join(runDir, "codex-artifact.json"), "utf8")))
      .toMatchObject({
        version: EXECUTION_ARTIFACT_VERSION,
        runId: manifest.runId,
        ...executionAttemptBinding(manifest.runId, 1, 0),
        threadId: null,
        usage: null,
        ok: false,
        eventsSha256: evidenceSha256(eventsText),
      });
  });

  it("restores trusted attempt counters when execution mutates run-state", async () => {
    const { workbench, runDir, manifest } = fixture("attempt-drift");

    await withExitCodeRestored(async () => {
      await expect(
        runSlot(manifest, workbench, runDir, {
          dependencies: {
            buildPrompt: () => "test prompt",
            runAgent: async () => {
              saveRunState(runDir, {
                retryCount: 1,
                slotIndex: 9,
                maxRetries: 3,
                lastStatus: "running",
              });
              return { ok: true, text: "done" };
            },
          },
        }),
      ).rejects.toThrow(/attempt binding changed/i);
    });

    expect(loadRunState(runDir)).toMatchObject({
      retryCount: 0,
      slotIndex: 1,
      lastStatus: "failed",
    });
    const artifact = JSON.parse(
      readFileSync(path.join(runDir, "codex-artifact.json"), "utf8"),
    );
    expect(artifact).toMatchObject(executionAttemptBinding(manifest.runId, 1, 0));
  });
});
