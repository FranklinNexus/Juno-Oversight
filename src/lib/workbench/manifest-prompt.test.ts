import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildManifestFromQueue,
  buildUserPrompt,
  loadRunState,
  materializeQueueRun,
} from "../../../orchestrator/src/manifest.js";
import type { QueueItem } from "../../../orchestrator/src/types.js";

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
});

describe("buildUserPrompt", () => {
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
  });
});
