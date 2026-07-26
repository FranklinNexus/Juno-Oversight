import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildManifestFromQueue,
  canonicalizeRunManifest,
  loadRunState,
  saveRunState,
  validateRunManifestControlFields,
} from "../../../orchestrator/src/manifest.js";
import type { RunManifest, RunState } from "../../../orchestrator/src/types.js";
import { revisionFixRunId } from "../../../orchestrator/src/revision-lineage.js";

function fixture(): { workbench: string; runDir: string; manifest: RunManifest } {
  const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-manifest-security-"));
  const runDir = path.join(workbench, "runs", "safe-run");
  mkdirSync(path.join(workbench, "prompts"), { recursive: true });
  mkdirSync(path.join(workbench, "missions", "safe-mission"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(workbench, "prompts", "executor_safe.md"), "# Safe\n", "utf8");
  return {
    workbench,
    runDir,
    manifest: {
      runId: "safe-run",
      horizon: "mission",
      missionId: "safe-mission",
      runKind: "implement",
      repoRoot: "workbench",
      provider: "openai_codex",
      promptTemplate: "executor_safe",
      cwd: "missions/safe-mission",
      maxMinutes: 25,
      maxRetries: 3,
      evalProfile: "code",
    },
  };
}

describe("manifest control validation", () => {
  it("accepts a bounded canonical manifest and fills legacy repo controls", () => {
    const { workbench, manifest } = fixture();
    expect(validateRunManifestControlFields(manifest, workbench)).toBe(manifest);

    const legacy = canonicalizeRunManifest(
      { ...manifest, runKind: undefined, repoRoot: undefined, provider: "cursor_composer" },
      workbench,
    );
    expect(legacy).toMatchObject({
      runKind: "implement",
      repoRoot: "workbench",
      provider: "openai_codex",
    });
    expect(() => validateRunManifestControlFields(legacy, workbench)).not.toThrow();
    const explicitNull = canonicalizeRunManifest(
      { ...manifest, runKind: null } as unknown as RunManifest,
      workbench,
    );
    expect(() => validateRunManifestControlFields(explicitNull, workbench)).toThrow(/runKind/);
  });

  it("fails closed on invalid enums, budgets, ids, prompt paths, and cwd", () => {
    const { workbench, manifest } = fixture();
    const invalid: Array<Record<string, unknown>> = [
      { runKind: "unknown" },
      { runKind: null },
      { repoRoot: "outside" },
      { repoRoot: null },
      { horizon: "forever" },
      { provider: "unknown" },
      { maxMinutes: "25" },
      { maxMinutes: 0 },
      { maxMinutes: 241 },
      { maxRetries: -1 },
      { maxRetries: 21 },
      { runId: ".." },
      { missionId: "C:" },
      { promptTemplate: "../executor_safe" },
      { promptTemplate: "CON" },
      { promptTemplate: "missing" },
      { cwd: "../outside" },
      { evalProfile: "unknown" },
    ];
    for (const override of invalid) {
      expect(() =>
        validateRunManifestControlFields({ ...manifest, ...override }, workbench),
      ).toThrow();
    }
  });

  it("rejects malformed queue controls before execution", () => {
    const { workbench } = fixture();
    const priorWorkbench = process.env.AGENT_WORKBENCH_ROOT;
    process.env.AGENT_WORKBENCH_ROOT = workbench;
    try {
      const manifest = buildManifestFromQueue({
        id: "safe-run",
        horizon: "mission",
        kind: "implement",
        run_kind: "implement",
        repo_target: "workbench",
        mission_id: "safe-mission",
        prompt: "executor_safe",
        max_minutes: Number.NaN,
      });
      expect(() => validateRunManifestControlFields(manifest, workbench)).toThrow(/maxMinutes/);
    } finally {
      if (priorWorkbench === undefined) delete process.env.AGENT_WORKBENCH_ROOT;
      else process.env.AGENT_WORKBENCH_ROOT = priorWorkbench;
    }
  });

  it("binds experiment manifests to their isolated mission cwd and fixture", () => {
    const { workbench, manifest } = fixture();
    const experiment = {
      ...manifest,
      phaseId: "phase-one",
      workflowId: "default",
      experimentId: "experiment-one",
      experimentArm: "candidate" as const,
      experimentEpisode: 1,
      sourcePhaseId: "source-phase",
      experimentFixtureSha256: "a".repeat(64),
      experimentPromptSha256: "b".repeat(64),
    };
    expect(() => validateRunManifestControlFields(experiment, workbench)).not.toThrow();
    expect(() => validateRunManifestControlFields(
      { ...experiment, cwd: "missions/another-mission" },
      workbench,
    )).toThrow(/isolated mission cwd/i);
    expect(() => validateRunManifestControlFields(
      { ...experiment, experimentFixtureSha256: undefined },
      workbench,
    )).toThrow(/metadata must be complete/i);
    expect(() => validateRunManifestControlFields(
      { ...experiment, experimentPromptSha256: undefined },
      workbench,
    )).toThrow(/metadata must be complete/i);
    expect(() => validateRunManifestControlFields(
      { ...experiment, experimentPromptSha256: "not-a-hash" },
      workbench,
    )).toThrow(/experimentPromptSha256 must be SHA-256/i);
  });

  it("requires a paired, bounded revision lineage with a derived implement run id", () => {
    const { workbench, manifest } = fixture();
    const parent = "review-parent";
    const revision = {
      ...manifest,
      runId: revisionFixRunId(parent, 1),
      revisionOf: parent,
      revisionAttempt: 1,
    };
    expect(() => validateRunManifestControlFields(revision, workbench)).not.toThrow();
    expect(() => validateRunManifestControlFields(
      { ...revision, revisionAttempt: undefined },
      workbench,
    )).toThrow(/provided together/i);
    expect(() => validateRunManifestControlFields(
      { ...revision, revisionOf: "../escape" },
      workbench,
    )).toThrow(/parent run id/i);
    expect(() => validateRunManifestControlFields(
      { ...revision, revisionAttempt: 21 },
      workbench,
    )).toThrow(/between 1 and 20/i);
    expect(() => validateRunManifestControlFields(
      { ...revision, runId: "forged-revision" },
      workbench,
    )).toThrow(/does not match/i);
    expect(() => validateRunManifestControlFields(
      { ...revision, runKind: "review" },
      workbench,
    )).toThrow(/runKind=implement/i);
  });
});

describe("run-state validation", () => {
  it("defaults only when missing and preserves valid counters", () => {
    const { runDir } = fixture();
    expect(loadRunState(runDir)).toEqual({ retryCount: 0, slotIndex: 0, maxRetries: 3 });
    const state: RunState = { retryCount: 2, slotIndex: 4, maxRetries: 3, lastStatus: "failed" };
    saveRunState(runDir, state);
    expect(loadRunState(runDir)).toEqual(state);
  });

  it("rejects malformed, non-numeric, and inconsistent persisted counters", () => {
    const { runDir } = fixture();
    const statePath = path.join(runDir, "run-state.json");
    writeFileSync(statePath, "{broken", "utf8");
    expect(() => loadRunState(runDir)).toThrow(/Invalid run-state JSON/);

    writeFileSync(
      statePath,
      JSON.stringify({ retryCount: "1", slotIndex: 0, maxRetries: 3 }),
      "utf8",
    );
    expect(() => loadRunState(runDir)).toThrow(/retryCount/);

    writeFileSync(
      statePath,
      JSON.stringify({ retryCount: 4, slotIndex: 0, maxRetries: 3 }),
      "utf8",
    );
    expect(() => loadRunState(runDir)).toThrow(/cannot exceed/);
  });
});
