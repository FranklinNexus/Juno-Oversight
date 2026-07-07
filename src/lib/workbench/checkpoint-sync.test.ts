import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readLastFinishedEvent,
  syncCheckpointFromEvents,
} from "../../../orchestrator/src/checkpoint-sync.js";
import {
  checkpointTextForAdvance,
  resolveQueueAdvance,
} from "../../../orchestrator/src/mission-progress.js";

describe("checkpoint-sync", () => {
  it("syncs implement checkpoint from finished event when run cp is stub", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-cp-sync-"));
    const runId = "juno-w03-juno-intro";
    const runDir = path.join(dir, "runs", runId);
    mkdirSync(runDir, { recursive: true });

    writeFileSync(
      path.join(runDir, "checkpoint.md"),
      "# Checkpoint\n\n## 目标\n（待 Agent 填写）\n",
      "utf8",
    );
    writeFileSync(
      path.join(runDir, "manifest.json"),
      JSON.stringify({ runKind: "implement" }),
      "utf8",
    );
    writeFileSync(
      path.join(runDir, "events.jsonl"),
      [
        JSON.stringify({ type: "status", status: "starting" }),
        JSON.stringify({
          type: "finished",
          status: "finished",
          result:
            "**w03-juno-intro** 已完成。\n\n## 改动摘要\n- updated intro\n\n| successCriteria | 状态 |\n| ✅ | ✅ |",
        }),
      ].join("\n"),
      "utf8",
    );

    expect(syncCheckpointFromEvents(dir, runId, "implement")).toBe(true);

    const cp = readFileSync(path.join(runDir, "checkpoint.md"), "utf8");
    expect(cp).toMatch(/STATUS:\s*COMPLETE/i);
    expect(cp).toMatch(/## CHANGES/);
    expect(cp).toMatch(/updated intro/);

    const advance = resolveQueueAdvance(
      "implement",
      checkpointTextForAdvance(dir, runId, undefined),
    );
    expect(advance).toEqual({ action: "dequeue" });
  });

  it("readLastFinishedEvent skips error finished lines", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-cp-ev-"));
    const runDir = path.join(dir, "runs", "x");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, "events.jsonl"),
      [
        JSON.stringify({ type: "finished", status: "error", result: "boom" }),
        JSON.stringify({ type: "finished", status: "finished", result: "ok done ✅" }),
      ].join("\n"),
      "utf8",
    );

    const ev = readLastFinishedEvent(runDir);
    expect(ev?.result).toMatch(/ok done/);
  });
});
