import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildManifestFromQueue,
  buildUserPrompt,
  loadRunState,
  materializeQueueRun,
  readPromptTemplateSnapshot,
} from "../../../orchestrator/src/manifest.js";
import type { QueueItem } from "../../../orchestrator/src/types.js";
import { buildReviseImplementItem } from "../../../orchestrator/src/mission-progress.js";
import { revisionFixRunId } from "../../../orchestrator/src/revision-lineage.js";

const missionId = "juno-overseer-hardening-2026";
let workbench = "";
const priorWorkbench = process.env.AGENT_WORKBENCH_ROOT;
const priorJunoRoot = process.env.JUNO_OVERSIGHT_ROOT;

beforeEach(() => {
  workbench = mkdtempSync(path.join(tmpdir(), "juno-wb-"));
  process.env.AGENT_WORKBENCH_ROOT = workbench;
  process.env.JUNO_OVERSIGHT_ROOT = path.resolve(import.meta.dirname, "../../..");

  const missionDir = path.join(workbench, "missions", missionId);
  mkdirSync(path.join(workbench, "prompts"), { recursive: true });
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(
    path.join(missionDir, "scope-lock.md"),
    "# Scope Lock\n\nAllowed paths only.\n",
    "utf8",
  );
  writeFileSync(
    path.join(missionDir, "north-star.md"),
    "# North Star\n\nReview alternating queue.\n",
    "utf8",
  );
  writeFileSync(
    path.join(missionDir, "progress.md"),
    "# Mission Progress\n\n| Phase | Status |\n",
    "utf8",
  );
  writeFileSync(
    path.join(workbench, "prompts", "executor_implement.md"),
    "# executor_implement\n\nImplement slot template.\n",
    "utf8",
  );
});

afterEach(() => {
  if (priorWorkbench) process.env.AGENT_WORKBENCH_ROOT = priorWorkbench;
  else delete process.env.AGENT_WORKBENCH_ROOT;
  if (priorJunoRoot) process.env.JUNO_OVERSIGHT_ROOT = priorJunoRoot;
  else delete process.env.JUNO_OVERSIGHT_ROOT;
});

describe("buildManifestFromQueue", () => {
  it("includes runKind and repoRoot on mission implement items", () => {
    const item: QueueItem = {
      id: "juno-h05-review-loop-code",
      horizon: "mission",
      kind: "implement",
      run_kind: "implement",
      repo_target: "juno-overseer",
      prompt: "executor_implement",
      mission_id: missionId,
      phase_id: "h05-review-loop-code",
    };

    const manifest = buildManifestFromQueue(item);
    expect(manifest.runKind).toBe("implement");
    expect(manifest.repoRoot).toBe("juno-overseer");
    expect(manifest.runId).toBe(item.id);
  });

  it("fails closed instead of materializing a default workflow from a corrupt active selection", () => {
    mkdirSync(path.join(workbench, "state"), { recursive: true });
    writeFileSync(
      path.join(workbench, "state", "workflow-selection.json"),
      "{broken-selection\n",
      "utf8",
    );
    const item: QueueItem = {
      id: "manifest-selection-fail-closed",
      horizon: "mission",
      kind: "implement",
      run_kind: "implement",
      repo_target: "juno-overseer",
      prompt: "executor_implement",
      mission_id: missionId,
      phase_id: "selection-fail-closed",
    };

    expect(() => buildManifestFromQueue(item)).toThrow(/present but invalid or untrusted/i);
    expect(existsSync(path.join(workbench, "runs", item.id))).toBe(false);
  });

  it("uses the mission directory for Workbench missions and rejects path traversal ids", () => {
    const item: QueueItem = {
      id: "book-write",
      horizon: "mission",
      kind: "implement",
      repo_target: "workbench",
      prompt: "executor_implement",
      mission_id: "juno-axiom-book-2026",
    };
    expect(buildManifestFromQueue(item).cwd).toBe("missions/juno-axiom-book-2026");
    expect(() =>
      buildManifestFromQueue({ ...item, id: "escape", mission_id: "../../escape" }),
    ).toThrow(/Invalid mission id/);
  });
});

describe("buildUserPrompt", () => {
  it("binds experiment execution to the exact prompt template bytes", () => {
    const templatePath = path.join(workbench, "prompts", "executor_implement.md");
    const originalBytes = readFileSync(templatePath);
    const expectedSha256 = createHash("sha256").update(originalBytes).digest("hex");
    expect(readPromptTemplateSnapshot(workbench, "executor_implement")).toMatchObject({
      filePath: templatePath,
      sha256: expectedSha256,
      byteLength: originalBytes.byteLength,
    });

    const item: QueueItem = {
      id: "wfexp-prompt-bound",
      horizon: "mission",
      kind: "implement",
      run_kind: "implement",
      repo_target: "workbench",
      prompt: "executor_implement",
      provider: "openai_codex",
      mission_id: missionId,
      phase_id: "prompt-bound-phase",
      workflow_id: "default",
      eval_profile: "code",
      experiment_id: "prompt-bound-experiment",
      experiment_arm: "candidate",
      experiment_episode: 1,
      source_phase_id: "source-phase",
      experiment_fixture_sha256: "a".repeat(64),
      experiment_prompt_sha256: expectedSha256,
    };
    const manifestPath = materializeQueueRun(item);
    const runDir = path.dirname(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.experimentPromptSha256).toBe(expectedSha256);
    expect(() => buildUserPrompt(
      { ...manifest, experimentPromptSha256: undefined },
      workbench,
      runDir,
      loadRunState(runDir),
    )).toThrow(/prompt SHA-256 binding is missing/i);

    writeFileSync(templatePath, "# changed after materialization\n", "utf8");
    expect(() =>
      buildUserPrompt(manifest, workbench, runDir, loadRunState(runDir)),
    ).toThrow(/prompt template changed/i);

    const driftedItem = { ...item, id: "wfexp-prompt-drifted" };
    expect(() => materializeQueueRun(driftedItem)).toThrow(/prompt template changed/i);
    expect(existsSync(path.join(workbench, "runs", driftedItem.id))).toBe(false);
  });

  it("rejects hard-linked and oversized prompt templates before materialization", () => {
    const hardlinkSource = path.join(workbench, "hardlink-source.md");
    const hardlinkTarget = path.join(workbench, "prompts", "executor_hardlink.md");
    writeFileSync(hardlinkSource, "# hard link\n", "utf8");
    linkSync(hardlinkSource, hardlinkTarget);
    const base: QueueItem = {
      id: "unsafe-prompt-hardlink",
      horizon: "day",
      kind: "implement",
      run_kind: "implement",
      repo_target: "workbench",
      prompt: "executor_hardlink",
      provider: "openai_codex",
    };
    expect(() => materializeQueueRun(base)).toThrow(/exclusive regular file/i);
    expect(existsSync(path.join(workbench, "runs", base.id))).toBe(false);

    writeFileSync(
      path.join(workbench, "prompts", "executor_oversized.md"),
      Buffer.alloc(256 * 1024 + 1, 0x61),
    );
    expect(() => materializeQueueRun({
      ...base,
      id: "unsafe-prompt-oversized",
      prompt: "executor_oversized",
    })).toThrow(/byte limit/i);
  });

  it("injects scope-lock excerpt and events tail", () => {
    const item: QueueItem = {
      id: "juno-h05-review-loop-code",
      horizon: "mission",
      kind: "implement",
      run_kind: "implement",
      repo_target: "juno-overseer",
      prompt: "executor_implement",
      mission_id: missionId,
      phase_id: "h05-review-loop-code",
    };

    const manifestPath = materializeQueueRun(item);
    const runDir = path.dirname(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReturnType<
      typeof buildManifestFromQueue
    >;

    writeFileSync(
      path.join(runDir, "events.jsonl"),
      [
        JSON.stringify({ ts: "2026-07-01T00:00:00Z", type: "status", status: "starting" }),
        JSON.stringify({ ts: "2026-07-01T00:00:01Z", type: "assistant", text: "hello" }),
      ].join("\n") + "\n",
      "utf8",
    );

    const prompt = buildUserPrompt(manifest, workbench, runDir, loadRunState(runDir));

    expect(prompt).toContain("- runKind: implement");
    expect(prompt).toContain("- repoRoot: juno-overseer");
    expect(prompt).toContain("## Mission scope-lock");
    expect(prompt).toContain("Allowed paths only.");
    expect(prompt).toContain("## Recent events (tail)");
    expect(prompt).toContain('"type":"assistant"');
    expect(prompt).toContain("Destructive ops firewall");
    expect(prompt).toContain("hard link");
    expect(prompt).toContain("checkpoint.md 是只读展示文件");
    expect(prompt).toContain("Mission 完成只能由父进程签发 receipt");
  });

  it("rebuilds MCP hints for the current mission instead of reusing stale global state", () => {
    mkdirSync(path.join(workbench, "config"), { recursive: true });
    mkdirSync(path.join(workbench, "state"), { recursive: true });
    writeFileSync(
      path.join(workbench, "config", "mcp-servers.json"),
      JSON.stringify({
        servers: [
          { id: "current-mission-mcp", enabled: true, missions: [missionId] },
          { id: "other-mission-mcp", enabled: true, missions: ["other-mission"] },
        ],
      }),
      "utf8",
    );
    writeFileSync(
      path.join(workbench, "state", "mcp-hints.json"),
      JSON.stringify({ enabledServers: [], promptBlock: "STALE-MCP-CONTEXT", updatedAt: "old" }),
      "utf8",
    );
    const item: QueueItem = {
      id: "mcp-current-run",
      horizon: "mission",
      kind: "implement",
      run_kind: "implement",
      repo_target: "juno-overseer",
      prompt: "executor_implement",
      mission_id: missionId,
    };
    const manifestPath = materializeQueueRun(item);
    const runDir = path.dirname(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReturnType<
      typeof buildManifestFromQueue
    >;

    const prompt = buildUserPrompt(manifest, workbench, runDir, loadRunState(runDir));

    expect(prompt).toContain("current-mission-mcp");
    expect(prompt).not.toContain("other-mission-mcp");
    expect(prompt).not.toContain("STALE-MCP-CONTEXT");
  });

  it("applies configured provider routing to legacy queue items", () => {
    mkdirSync(path.join(workbench, "config"), { recursive: true });
    writeFileSync(
      path.join(workbench, "config", "model-defaults.json"),
      JSON.stringify({ providerAliases: { cursor_composer: "openai_codex" } }),
      "utf8",
    );
    const item: QueueItem = {
      id: "legacy-cursor-item",
      horizon: "mission",
      kind: "review",
      run_kind: "review",
      repo_target: "juno-overseer",
      prompt: "executor_implement",
      provider: "cursor_composer",
      mission_id: missionId,
      model: "composer-2.5",
    };

    const manifest = buildManifestFromQueue(item);
    expect(manifest.provider).toBe("openai_codex");
    expect(manifest.model).toBeUndefined();
  });

  it("materializes revision lineage into camelCase manifest controls", () => {
    const parent: QueueItem = {
      id: "review-parent",
      horizon: "mission",
      kind: "review",
      run_kind: "review",
      repo_target: "workbench",
      prompt: "executor_implement",
      provider: "openai_codex",
      mission_id: missionId,
      phase_id: "review-phase",
    };
    const fix = buildReviseImplementItem(parent, 1, ["fix evidence"]);
    const manifestPath = materializeQueueRun(fix);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const queueItem = JSON.parse(
      readFileSync(path.join(path.dirname(manifestPath), "queue-item.json"), "utf8"),
    );

    expect(manifest).toMatchObject({
      runId: revisionFixRunId(parent.id, 1),
      revisionOf: parent.id,
      revisionAttempt: 1,
    });
    expect(queueItem).toMatchObject({
      revision_of: parent.id,
      revision_attempt: 1,
    });
  });
});
