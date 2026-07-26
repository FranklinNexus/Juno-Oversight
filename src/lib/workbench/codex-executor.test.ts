import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodexClientOptions,
  buildCodexEnvironment,
  buildCodexThreadOptions,
  runCodexExecutor,
} from "../../../orchestrator/src/codex-executor.js";
import {
  EXECUTION_ARTIFACT_VERSION,
  evidenceSha256,
  executionAttemptBinding,
  manifestEvidenceSha256,
} from "../../../orchestrator/src/execution-artifact.js";
import type { RunManifest } from "../../../orchestrator/src/types.js";

function manifest(runKind: RunManifest["runKind"]): RunManifest {
  return {
    runId: `codex-${runKind}`,
    horizon: "mission",
    runKind,
    repoRoot: "juno-overseer",
    provider: "openai_codex",
    promptTemplate: "executor_review",
    cwd: ".",
    maxMinutes: 1,
    maxRetries: 0,
  };
}

describe("Codex executor", () => {
  it("uses bounded thread options and strips provider secrets from the child environment", () => {
    const runDir = path.join(os.tmpdir(), "codex-options");
    const options = buildCodexThreadOptions(manifest("implement"), os.tmpdir(), runDir);
    expect(options.sandboxMode).toBe("workspace-write");
    expect(options.approvalPolicy).toBe("never");
    expect(options.networkAccessEnabled).toBe(false);
    expect(options.additionalDirectories).toEqual([path.join(runDir, "output")]);

    const legacyKey = ["CURSOR", "API", "KEY"].join("_");
    const openAiKey = ["OPENAI", "API", "KEY"].join("_");
    const env = buildCodexEnvironment({
      PATH: "safe-path",
      USERPROFILE: "safe-home",
      [legacyKey]: ["secret", "cursor"].join("-"),
      [openAiKey]: ["secret", "openai"].join("-"),
    });
    expect(env.PATH).toBe("safe-path");
    expect(env.USERPROFILE).toBe("safe-home");
    expect(env).not.toHaveProperty(legacyKey);
    expect(env).not.toHaveProperty(openAiKey);

    const fakeCodex = path.join(
      mkdtempSync(path.join(os.tmpdir(), "juno-codex-path-")),
      process.platform === "win32" ? "codex.exe" : "codex",
    );
    writeFileSync(fakeCodex, "test", "utf8");
    const clientOptions = buildCodexClientOptions({
      PATH: "safe-path",
      JUNO_PACKAGED_RUNTIME: "1",
      JUNO_CODEX_PATH: fakeCodex,
    });
    expect(clientOptions.codexPathOverride).toBe(fakeCodex);
    expect(clientOptions.env).toEqual({ PATH: "safe-path" });
    expect(() =>
      buildCodexClientOptions({ JUNO_PACKAGED_RUNTIME: "1" }),
    ).toThrow(/installed Codex CLI/);

    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-codex-cwd-"));
    const missionId = "juno-axiom-book-2026";
    const workbenchManifest: RunManifest = {
      ...manifest("implement"),
      repoRoot: "workbench",
      missionId,
      cwd: `missions/${missionId}`,
    };
    const workbenchRunDir = path.join(workbench, "runs", "book-write");
    const workbenchOptions = buildCodexThreadOptions(
      workbenchManifest,
      workbench,
      workbenchRunDir,
    );
    expect(workbenchOptions.workingDirectory).toBe(
      path.join(workbench, "missions", missionId),
    );
    expect(workbenchOptions.additionalDirectories).toEqual([
      path.join(workbenchRunDir, "output"),
    ]);
  });

  it("promotes only the isolated implement checkpoint into trusted run state", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-codex-implement-wb-"));
    const runDir = path.join(workbench, "runs", "implement");
    const agentCheckpoint = path.join(runDir, "output", "checkpoint.md");
    const secret = ["sk", "abcdefghijklmnop"].join("-");
    async function* events() {
      mkdirSync(path.dirname(agentCheckpoint), { recursive: true });
      writeFileSync(
        agentCheckpoint,
        `STATUS: COMPLETE\n\n## CHANGES\n- implemented safely\n- token=${secret}\n`,
        "utf8",
      );
      yield { type: "thread.started", thread_id: "thread-implement" } as const;
      yield {
        type: "item.completed",
        item: { id: "message", type: "agent_message", text: `done ${secret}` },
      } as const;
      yield {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      } as const;
    }

    const result = await runCodexExecutor(
      { manifest: manifest("implement"), workbench, runDir, prompt: "implement" },
      {
        createClient: () => ({
          startThread: () => ({
            id: "thread-implement",
            runStreamed: async () => ({ events: events() }),
          }),
        }),
      },
    );

    expect(result.ok, result.text).toBe(true);
    const trustedCheckpoint = readFileSync(path.join(runDir, "checkpoint.md"), "utf8");
    expect(trustedCheckpoint).toContain("STATUS: COMPLETE");
    expect(trustedCheckpoint).toContain("[REDACTED]");
    expect(trustedCheckpoint).not.toContain(secret);
    expect(readFileSync(agentCheckpoint, "utf8")).not.toContain(secret);
    const evidence = readFileSync(path.join(runDir, "events.jsonl"), "utf8");
    expect(evidence).not.toContain(secret);
    expect(evidence).toContain("[REDACTED]");
  });

  it("rejects a hard-linked agent checkpoint without modifying its mission target", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-codex-hardlink-wb-"));
    const missionId = "mission-hardlink-target";
    const missionDir = path.join(workbench, "missions", missionId);
    const missionCheckpoint = path.join(missionDir, "checkpoint.md");
    const runDir = path.join(workbench, "runs", "hardlink-output");
    const agentCheckpoint = path.join(runDir, "output", "checkpoint.md");
    const trustedCheckpoint = path.join(runDir, "checkpoint.md");
    const secret = ["sk", "abcdefghijklmnopqrstuvwx"].join("-");
    const original = `STATUS: COMPLETE\n\n## CHANGES\n- token=${secret}\n`;
    mkdirSync(missionDir, { recursive: true });
    mkdirSync(path.dirname(agentCheckpoint), { recursive: true });
    writeFileSync(missionCheckpoint, original, "utf8");
    writeFileSync(trustedCheckpoint, "trusted checkpoint must remain\n", "utf8");

    async function* events() {
      linkSync(missionCheckpoint, agentCheckpoint);
      expect(lstatSync(agentCheckpoint).nlink).toBeGreaterThan(1);
      yield {
        type: "item.completed",
        item: { id: "message", type: "agent_message", text: "done" },
      } as const;
      yield {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      } as const;
    }

    const result = await runCodexExecutor(
      {
        manifest: {
          ...manifest("implement"),
          runId: "hardlink-output",
          repoRoot: "workbench",
          missionId,
          cwd: `missions/${missionId}`,
        },
        workbench,
        runDir,
        prompt: "implement",
      },
      {
        createClient: () => ({
          startThread: () => ({
            id: "thread-hardlink",
            runStreamed: async () => ({ events: events() }),
          }),
        }),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/hard.?link/i);
    expect(readFileSync(missionCheckpoint, "utf8")).toBe(original);
    expect(readFileSync(trustedCheckpoint, "utf8")).toBe("trusted checkpoint must remain\n");
  });

  it("fails an implement turn that does not produce a fresh isolated checkpoint", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-codex-no-checkpoint-wb-"));
    const runDir = path.join(workbench, "runs", "implement");
    async function* events() {
      yield { type: "thread.started", thread_id: "thread-no-checkpoint" } as const;
      yield {
        type: "item.completed",
        item: { id: "message", type: "agent_message", text: "done" },
      } as const;
      yield {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      } as const;
    }
    const result = await runCodexExecutor(
      { manifest: manifest("implement"), workbench, runDir, prompt: "implement" },
      {
        createClient: () => ({
          startThread: () => ({
            id: "thread-no-checkpoint",
            runStreamed: async () => ({ events: events() }),
          }),
        }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/missing agent checkpoint/i);
  });

  it("rejects an output junction before acquiring an API lease", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-codex-output-link-wb-"));
    const runDir = path.join(workbench, "runs", "linked-output");
    const outside = mkdtempSync(path.join(os.tmpdir(), "juno-codex-output-target-"));
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(outside, "checkpoint.md"), "must remain\n", "utf8");
    symlinkSync(outside, path.join(runDir, "output"), process.platform === "win32" ? "junction" : "dir");

    await expect(
      runCodexExecutor(
        { manifest: manifest("implement"), workbench, runDir, prompt: "implement" },
        {
          createClient: () => {
            throw new Error("Codex client must not start after failed preflight");
          },
        },
      ),
    ).rejects.toThrow(/Agent output directory is not a regular directory/);

    expect(readFileSync(path.join(outside, "checkpoint.md"), "utf8")).toBe("must remain\n");
    expect(existsSync(path.join(workbench, "state", "api-quota.json"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(runDir, "codex-artifact.json"), "utf8")))
      .toMatchObject({
        version: EXECUTION_ARTIFACT_VERSION,
        ok: false,
        failure: expect.stringMatching(/output directory/i),
      });
  });

  it("rejects a pre-existing hard link in a writable mission before Codex starts", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-codex-mission-hardlink-wb-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "juno-codex-mission-hardlink-target-"));
    const missionId = "mission-preflight-hardlink";
    const missionDir = path.join(workbench, "missions", missionId);
    const runDir = path.join(workbench, "runs", "preflight-hardlink");
    const outsideTarget = path.join(outside, "must-not-change.txt");
    mkdirSync(missionDir, { recursive: true });
    writeFileSync(outsideTarget, "must remain\n", "utf8");
    linkSync(outsideTarget, path.join(missionDir, "linked-target.txt"));

    await expect(
      runCodexExecutor(
        {
          manifest: {
            ...manifest("implement"),
            runId: "preflight-hardlink",
            repoRoot: "workbench",
            missionId,
            cwd: `missions/${missionId}`,
          },
          workbench,
          runDir,
          prompt: "implement",
        },
        {
          createClient: () => {
            throw new Error("Codex client must not start after failed preflight");
          },
        },
      ),
    ).rejects.toThrow(/hard.?link/i);

    expect(readFileSync(outsideTarget, "utf8")).toBe("must remain\n");
    expect(existsSync(path.join(workbench, "state", "api-quota.json"))).toBe(false);
  });

  it("rejects a nested mission junction before Codex starts", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-codex-mission-link-wb-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "juno-codex-mission-link-target-"));
    const missionId = "mission-preflight-link";
    const missionDir = path.join(workbench, "missions", missionId);
    const runDir = path.join(workbench, "runs", "preflight-link");
    mkdirSync(missionDir, { recursive: true });
    writeFileSync(path.join(outside, "must-not-change.txt"), "must remain\n", "utf8");
    symlinkSync(
      outside,
      path.join(missionDir, "linked-directory"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      runCodexExecutor(
        {
          manifest: {
            ...manifest("implement"),
            runId: "preflight-link",
            repoRoot: "workbench",
            missionId,
            cwd: `missions/${missionId}`,
          },
          workbench,
          runDir,
          prompt: "implement",
        },
        {
          createClient: () => {
            throw new Error("Codex client must not start after failed preflight");
          },
        },
      ),
    ).rejects.toThrow(/symbolic link/i);

    expect(readFileSync(path.join(outside, "must-not-change.txt"), "utf8")).toBe("must remain\n");
    expect(existsSync(path.join(workbench, "state", "api-quota.json"))).toBe(false);
  });

  it("rejects an invalid prior checkpoint before acquiring an API lease", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-codex-invalid-cp-wb-"));
    const runDir = path.join(workbench, "runs", "invalid-checkpoint");
    mkdirSync(path.join(runDir, "output", "checkpoint.md"), { recursive: true });

    await expect(
      runCodexExecutor(
        { manifest: manifest("implement"), workbench, runDir, prompt: "implement" },
        {
          createClient: () => {
            throw new Error("Codex client must not start after failed preflight");
          },
        },
      ),
    ).rejects.toThrow(/Previous agent checkpoint is not a regular file/);

    expect(existsSync(path.join(workbench, "state", "api-quota.json"))).toBe(false);
  });

  it("records streamed evidence and copies an exact read-only review response to checkpoint", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-codex-review-wb-"));
    const runDir = path.join(workbench, "runs", "review");
    const review = [
      "## REVIEW_VERDICT",
      "verdict: PASS",
      "drift: none",
      "scope_violations: []",
      "must_fix_next_slot: []",
      "reviewer_notes: reviewed",
    ].join("\n");
    async function* events() {
      yield { type: "thread.started", thread_id: "thread-test" } as const;
      yield {
        type: "item.completed",
        item: {
          id: "cmd",
          type: "command_execution",
          command: "git diff --check",
          aggregated_output: "",
          exit_code: 0,
          status: "completed",
        },
      } as const;
      yield {
        type: "item.completed",
        item: { id: "message", type: "agent_message", text: review },
      } as const;
      yield {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      } as const;
    }
    const runManifest = manifest("review");
    const result = await runCodexExecutor(
      {
        manifest: runManifest,
        workbench,
        runDir,
        prompt: "review",
      },
      {
        createClient: () => ({
          startThread: () => ({
            id: "thread-test",
            runStreamed: async () => ({ events: events() }),
          }),
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(runDir, "checkpoint.md"), "utf8").trim()).toBe(review);
    const checkpoint = readFileSync(path.join(runDir, "checkpoint.md"), "utf8");
    const eventsText = readFileSync(path.join(runDir, "events.jsonl"), "utf8");
    expect(eventsText).toContain("git diff --check");
    expect(JSON.parse(readFileSync(path.join(runDir, "codex-artifact.json"), "utf8")))
      .toMatchObject({
        version: EXECUTION_ARTIFACT_VERSION,
        runId: runManifest.runId,
        manifestSha256: manifestEvidenceSha256(runManifest),
        checkpointSha256: evidenceSha256(checkpoint),
        eventsSha256: evidenceSha256(eventsText),
      });
  });

  it("fails closed when the SDK stream ends without turn.completed", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-codex-incomplete-wb-"));
    const runDir = path.join(workbench, "runs", "incomplete");
    async function* events() {
      yield {
        type: "item.completed",
        item: { id: "message", type: "agent_message", text: "partial response" },
      } as const;
    }
    const result = await runCodexExecutor(
      {
        manifest: manifest("review"),
        workbench,
        runDir,
        prompt: "review",
      },
      {
        createClient: () => ({
          startThread: () => ({
            id: "thread-incomplete",
            runStreamed: async () => ({ events: events() }),
          }),
        }),
      },
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(path.join(runDir, "codex-artifact.json"), "utf8")).toContain(
      "without turn.completed",
    );
  });

  it("writes a bound failure artifact when the provider gate throws", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-codex-gate-wb-"));
    const runDir = path.join(workbench, "runs", "gate-failure");
    mkdirSync(path.join(workbench, "config"), { recursive: true });
    writeFileSync(path.join(workbench, "config", "api-limits.json"), "{invalid json\n", "utf8");
    const runManifest = { ...manifest("review"), runId: "gate-failure" };
    const attempt = executionAttemptBinding(runManifest.runId, 2, 1);

    const result = await runCodexExecutor(
      { manifest: runManifest, workbench, runDir, prompt: "review", attempt },
      {
        createClient: () => {
          throw new Error("Codex client must not start after provider gate failure");
        },
      },
    );

    expect(result.ok).toBe(false);
    const eventsText = readFileSync(path.join(runDir, "events.jsonl"), "utf8");
    expect(JSON.parse(readFileSync(path.join(runDir, "codex-artifact.json"), "utf8")))
      .toMatchObject({
        version: EXECUTION_ARTIFACT_VERSION,
        runId: runManifest.runId,
        ...attempt,
        threadId: null,
        ok: false,
        failure: expect.stringMatching(/provider gate error/i),
        eventsSha256: evidenceSha256(eventsText),
      });
  });

  it("records an explicit terminal failure when a completed turn has no final response", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-codex-empty-final-wb-"));
    const runDir = path.join(workbench, "runs", "empty-final");
    const runManifest = { ...manifest("review"), runId: "empty-final" };
    async function* events() {
      yield { type: "thread.started", thread_id: "thread-empty-final" } as const;
      yield {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        },
      } as const;
    }

    const result = await runCodexExecutor(
      { manifest: runManifest, workbench, runDir, prompt: "review" },
      {
        createClient: () => ({
          startThread: () => ({
            id: "thread-empty-final",
            runStreamed: async () => ({ events: events() }),
          }),
        }),
      },
    );

    expect(result).toMatchObject({ ok: false, text: "Codex returned no final response" });
    expect(JSON.parse(readFileSync(path.join(runDir, "codex-artifact.json"), "utf8")))
      .toMatchObject({
        version: EXECUTION_ARTIFACT_VERSION,
        ok: false,
        failure: "Codex returned no final response",
      });
  });
});
