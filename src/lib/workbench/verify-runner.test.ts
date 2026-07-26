import { describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildVerifyEnvironment,
  redactVerifyOutput,
  runCommand,
  runDeterministicVerify,
  runVerifySteps,
  startVerifyHeartbeat,
} from "../../../orchestrator/src/verify-runner.js";
import {
  EXECUTION_ARTIFACT_VERSION,
  evidenceSha256,
  manifestEvidenceSha256,
} from "../../../orchestrator/src/execution-artifact.js";
import { evaluateCompletedRun } from "../../../orchestrator/src/mission-progress.js";
import type { RunManifest } from "../../../orchestrator/src/types.js";

function manifest(runId: string): RunManifest {
  return {
    runId,
    horizon: "mission",
    runKind: "verify",
    repoRoot: "juno-overseer",
    provider: "openai_codex",
    promptTemplate: "verify",
    cwd: ".",
    maxMinutes: 1,
    maxRetries: 0,
    evalProfile: "code",
  };
}

describe("deterministic verify runner", () => {
  it("writes machine evidence and a PASS checkpoint from real exit codes", async () => {
    const runDir = mkdtempSync(path.join(os.tmpdir(), "juno-verify-pass-"));
    const runManifest = manifest("pass");
    const result = await runVerifySteps(runManifest, runDir, process.cwd(), [
      { label: "pass", cmd: process.execPath, args: ["-e", "process.exit(0)"] },
    ]);
    expect(result.ok).toBe(true);
    expect(result.checkpoint).toContain("verdict: PASS");
    const checkpoint = readFileSync(path.join(runDir, "checkpoint.md"), "utf8");
    const events = readFileSync(path.join(runDir, "events.jsonl"), "utf8");
    const artifact = JSON.parse(
      readFileSync(path.join(runDir, "verify-artifact.json"), "utf8"),
    );
    expect(artifact).toMatchObject({
      version: EXECUTION_ARTIFACT_VERSION,
      runId: runManifest.runId,
      manifestSha256: manifestEvidenceSha256(runManifest),
      checkpointSha256: evidenceSha256(checkpoint),
      eventsSha256: evidenceSha256(events),
    });
  });

  it("runs pnpm through a shell-free Node entrypoint on Windows", async () => {
    const runDir = mkdtempSync(path.join(os.tmpdir(), "juno-verify-pnpm-"));
    const result = await runVerifySteps(manifest("pnpm"), runDir, process.cwd(), [
      { label: "pnpm version", cmd: "pnpm", args: ["--version"] },
    ]);

    expect(result.ok).toBe(true);
    expect(result.steps[0].command.toLowerCase()).not.toContain("corepack.cmd");
    expect(result.steps[0].stdout).toMatch(/10\.13\.1/);
  });

  it("fails closed on nonzero required steps but tolerates optional failures", async () => {
    const failDir = mkdtempSync(path.join(os.tmpdir(), "juno-verify-fail-"));
    const failed = await runVerifySteps(manifest("fail"), failDir, process.cwd(), [
      { label: "fail", cmd: process.execPath, args: ["-e", "process.exit(7)"] },
    ]);
    expect(failed.ok).toBe(false);
    expect(failed.checkpoint).toContain("verdict: FAIL");

    const optionalDir = mkdtempSync(path.join(os.tmpdir(), "juno-verify-optional-"));
    const optional = await runVerifySteps(manifest("optional"), optionalDir, process.cwd(), [
      { label: "optional", cmd: process.execPath, args: ["-e", "process.exit(2)"], optional: true },
    ]);
    expect(optional.ok).toBe(true);
    expect(readFileSync(path.join(optionalDir, "checkpoint.md"), "utf8")).toContain("WARN");
  });

  it("terminates a timed-out verifier process tree", async () => {
    const started = Date.now();
    const result = await runCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      process.cwd(),
      100,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.error).toContain("timed out");
    expect(result.terminationConfirmed).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("reports an unconfirmed verifier termination explicitly", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      process.cwd(),
      50,
      undefined,
      {
        killTree: () => false,
        isAlive: () => true,
        forceSettleMs: 50,
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(true);
    expect(result.terminationConfirmed).toBe(false);
    expect(result.error).toContain("termination unconfirmed");
  });

  it("does not infer tree termination from the parent pid exiting", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      process.cwd(),
      50,
      undefined,
      {
        killTree: () => false,
        isAlive: () => false,
        forceSettleMs: 50,
      },
    );
    expect(result.timedOut).toBe(true);
    expect(result.terminationConfirmed).toBe(false);
    expect(result.error).toContain("termination unconfirmed");
  });

  it("refreshes and stops the heartbeat around long verify commands", () => {
    vi.useFakeTimers();
    const runDir = mkdtempSync(path.join(os.tmpdir(), "juno-verify-heartbeat-"));
    const heartbeatPath = path.join(runDir, "heartbeat.json");
    try {
      vi.setSystemTime(new Date("2026-07-12T00:00:00.000Z"));
      const stop = startVerifyHeartbeat(runDir, 1_000);
      vi.advanceTimersByTime(1_000);
      const first = readFileSync(heartbeatPath, "utf8");
      expect(first).toContain("2026-07-12T00:00:01.000Z");
      stop();
      vi.advanceTimersByTime(5_000);
      expect(readFileSync(heartbeatPath, "utf8")).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("needs no provider key and blocks dequeue from real nonzero evidence", async () => {
    const priorKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-verify-integration-"));
      const runDir = path.join(workbench, "runs", "verify-no-key");
      mkdirSync(runDir, { recursive: true });
      const runManifest = manifest("verify-no-key");
      writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(runManifest), "utf8");

      const result = await runVerifySteps(runManifest, runDir, process.cwd(), [
        { label: "real failure", cmd: process.execPath, args: ["-e", "process.exit(9)"] },
      ]);
      const artifact = JSON.parse(
        readFileSync(path.join(runDir, "verify-artifact.json"), "utf8"),
      ) as { ok: boolean; steps: Array<{ exitCode: number }> };

      expect(result.ok).toBe(false);
      expect(artifact.ok).toBe(false);
      expect(artifact.steps[0].exitCode).toBe(9);
      expect(evaluateCompletedRun(workbench, "verify-no-key")).toEqual({ action: "block" });
    } finally {
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorKey;
    }
  });

  it("strips provider secrets from child commands and redacts persisted output", () => {
    const openAiKey = ["OPENAI", "API", "KEY"].join("_");
    const legacyKey = ["CURSOR", "API", "KEY"].join("_");
    const providerSecret = ["super", "secret", "provider", "value"].join("-");
    const env = buildVerifyEnvironment({
      PATH: "safe-path",
      NODE_ENV: "production",
      [openAiKey]: providerSecret,
      [legacyKey]: ["legacy", "secret", "provider", "value"].join("-"),
    });
    expect(env.PATH).toBe("safe-path");
    expect(env.NODE_ENV).toBe("production");
    expect(env).not.toHaveProperty(openAiKey);
    expect(env).not.toHaveProperty(legacyKey);
    expect(
      redactVerifyOutput(`${"token="}${providerSecret}`, {
        [openAiKey]: providerSecret,
      }),
    ).toBe("token=[REDACTED]");
    expect(
      redactVerifyOutput(
        [
          `Authorization: ${"Bearer"} ${"eyJ"}${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`,
          `${"Cookie"}: sessionid=${"secret-session-value"}`,
          `${"token="}${"ghp_"}${"d".repeat(30)}`,
        ].join("\n"),
        {},
      ),
    ).not.toMatch(/eyJhbGci|secret-session-value|ghp_/);
  });

  it("redacts secrets from persisted command arguments and output", async () => {
    const runDir = mkdtempSync(path.join(os.tmpdir(), "juno-verify-redact-"));
    const secret = `${"ghp_"}${"a".repeat(30)}`;
    await runVerifySteps(manifest("redact"), runDir, process.cwd(), [
      {
        label: "secret output",
        cmd: process.execPath,
        args: ["-e", `process.stdout.write("Authorization: Bearer ${secret}")`],
      },
    ]);
    const persisted = [
      readFileSync(path.join(runDir, "events.jsonl"), "utf8"),
      readFileSync(path.join(runDir, "verify-artifact.json"), "utf8"),
    ].join("\n");
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[REDACTED]");
  });

  it("fails the actual Workbench target instead of falling back to the Juno repository", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-verify-target-wb-"));
    const target = path.join(workbench, "missions", "no-package");
    const runDir = path.join(workbench, "runs", "target-check");
    mkdirSync(target, { recursive: true });
    const previous = process.env.AGENT_WORKBENCH_ROOT;
    process.env.AGENT_WORKBENCH_ROOT = workbench;
    try {
      const result = await runDeterministicVerify(
        {
          ...manifest("target-check"),
          repoRoot: "workbench",
          cwd: "missions/no-package",
        },
        runDir,
      );
      expect(result.ok).toBe(false);
      expect(result.steps[0].label).toBe("Workbench package execution has an OS sandbox");
      const artifact = JSON.parse(
        readFileSync(path.join(runDir, "verify-artifact.json"), "utf8"),
      );
      expect(artifact.cwd).toBe(target);
    } finally {
      if (previous === undefined) delete process.env.AGENT_WORKBENCH_ROOT;
      else process.env.AGENT_WORKBENCH_ROOT = previous;
    }
  });

  it("never executes Agent-generated Workbench package scripts on the host", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-verify-untrusted-wb-"));
    const target = path.join(workbench, "missions", "untrusted-package");
    const runDir = path.join(workbench, "runs", "untrusted-check");
    const marker = path.join(workbench, "host-script-ran.txt");
    mkdirSync(target, { recursive: true });
    writeFileSync(
      path.join(target, "package.json"),
      JSON.stringify({
        scripts: {
          test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`,
        },
      }),
      "utf8",
    );
    const previous = process.env.AGENT_WORKBENCH_ROOT;
    process.env.AGENT_WORKBENCH_ROOT = workbench;
    try {
      const result = await runDeterministicVerify(
        {
          ...manifest("untrusted-check"),
          repoRoot: "workbench",
          cwd: "missions/untrusted-package",
        },
        runDir,
      );
      expect(result.ok).toBe(false);
      expect(existsSync(marker)).toBe(false);
      expect(result.steps[0].stderr).toBe("");
      expect(result.steps[0].stdout).toContain("Refusing to execute");
    } finally {
      if (previous === undefined) delete process.env.AGENT_WORKBENCH_ROOT;
      else process.env.AGENT_WORKBENCH_ROOT = previous;
    }
  });

  it("blocks before host commands when the mission safety baseline is missing", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-verify-preflight-"));
    const runDir = path.join(workbench, "runs", "preflight-check");
    mkdirSync(path.join(workbench, "missions", "safe-mission"), { recursive: true });
    const previous = process.env.AGENT_WORKBENCH_ROOT;
    process.env.AGENT_WORKBENCH_ROOT = workbench;
    try {
      const result = await runDeterministicVerify(
        {
          ...manifest("preflight-check"),
          missionId: "safe-mission",
        },
        runDir,
      );
      expect(result.ok).toBe(false);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toMatchObject({
        label: "mission safety preflight",
        command: "orchestrator:safety-verify",
        ok: false,
      });
      expect(readFileSync(path.join(runDir, "safety-verify.md"), "utf8")).toContain(
        "no valid v3 safety baseline",
      );
    } finally {
      if (previous === undefined) delete process.env.AGENT_WORKBENCH_ROOT;
      else process.env.AGENT_WORKBENCH_ROOT = previous;
    }
  });

  it("rejects a Workbench target that escapes through a directory link", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "juno-verify-link-"));
    const workbench = path.join(base, "workbench");
    const outside = path.join(base, "outside");
    const runDir = path.join(workbench, "runs", "link-check");
    mkdirSync(path.join(workbench, "missions"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(
      outside,
      path.join(workbench, "missions", "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const previous = process.env.AGENT_WORKBENCH_ROOT;
    process.env.AGENT_WORKBENCH_ROOT = workbench;
    try {
      await expect(
        runDeterministicVerify(
          {
            ...manifest("link-check"),
            repoRoot: "workbench",
            cwd: "missions/escape",
          },
          runDir,
        ),
      ).rejects.toThrow(/escapes the Workbench through a link/);
    } finally {
      if (previous === undefined) delete process.env.AGENT_WORKBENCH_ROOT;
      else process.env.AGENT_WORKBENCH_ROOT = previous;
    }
  });
});
