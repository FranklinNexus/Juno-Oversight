import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  isSafePurgePath,
  planWorkbenchPurge,
  executeWorkbenchPurge,
  DEFAULT_PURGE_POLICY,
} from "../../../orchestrator/src/workbench-purge.js";

function wb(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "juno-purge-"));
  for (const sub of ["runs", "staging", "missions", "config", "state", "queue"]) {
    mkdirSync(path.join(dir, sub), { recursive: true });
  }
  writeFileSync(
    path.join(dir, "state", "orchestrator.json"),
    JSON.stringify({ activeRunId: "keep-me" }),
    "utf8",
  );
  return dir;
}

describe("workbench-purge", () => {
  it("blocks paths outside workbench and forbidden tops", () => {
    const root = wb();
    expect(isSafePurgePath(root, path.join(root, "runs", "old"))).toBe(true);
    expect(isSafePurgePath(root, path.join(root, "missions", "x"))).toBe(false);
    expect(isSafePurgePath(root, path.join(root, "state", "x.json"))).toBe(false);
    expect(isSafePurgePath(root, "C:\\Windows\\Temp")).toBe(false);
  });

  it("keeps empty runs in runsKeepRecent set", () => {
    const root = wb();
    const recent = path.join(root, "runs", "recent-empty");
    const old = path.join(root, "runs", "old-empty");
    mkdirSync(recent, { recursive: true });
    mkdirSync(old, { recursive: true });
    const now = Date.now();
    utimesSync(recent, now / 1000, now / 1000);
    utimesSync(old, (now - 86_400_000) / 1000, (now - 86_400_000) / 1000);

    const plan = planWorkbenchPurge(root, {
      ...DEFAULT_PURGE_POLICY,
      runsRetentionDays: 0,
      runsKeepRecent: 1,
      purgeEmptyRuns: true,
    });

    expect(plan.candidates.some((c) => c.relativePath.includes("recent-empty"))).toBe(false);
    expect(plan.candidates.some((c) => c.relativePath.includes("old-empty"))).toBe(true);
  });

  it("never deletes activeRunId", () => {
    const root = wb();
    mkdirSync(path.join(root, "runs", "keep-me"), { recursive: true });
    mkdirSync(path.join(root, "runs", "old-run"), { recursive: true });
    writeFileSync(path.join(root, "runs", "old-run", "events.jsonl"), "x", "utf8");

    const oldMtime = Date.now() - 30 * 86_400_000;
    utimesSync(path.join(root, "runs", "old-run"), oldMtime / 1000, oldMtime / 1000);

    const plan = planWorkbenchPurge(root, {
      ...DEFAULT_PURGE_POLICY,
      runsRetentionDays: 1,
      runsKeepRecent: 0,
    });

    expect(plan.candidates.some((c) => c.relativePath.includes("keep-me"))).toBe(false);
    expect(plan.candidates.some((c) => c.relativePath.includes("old-run"))).toBe(true);
  });

  it("dry-run does not remove files", () => {
    const root = wb();
    const runDir = path.join(root, "runs", "stale");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "a.txt"), "data", "utf8");

    const plan = planWorkbenchPurge(root, {
      ...DEFAULT_PURGE_POLICY,
      runsRetentionDays: 0,
      runsKeepRecent: 0,
    });
    executeWorkbenchPurge(root, plan, { dryRun: true });
    expect(existsSync(path.join(runDir, "a.txt"))).toBe(true);
  });

  it("execute removes only allowed paths", () => {
    const root = wb();
    const runDir = path.join(root, "runs", "stale");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "a.txt"), "data", "utf8");
    mkdirSync(path.join(root, "missions", "m"), { recursive: true });
    writeFileSync(path.join(root, "missions", "m", "keep.md"), "keep", "utf8");

    const plan = planWorkbenchPurge(root, {
      ...DEFAULT_PURGE_POLICY,
      runsRetentionDays: 0,
      runsKeepRecent: 0,
    });
    const result = executeWorkbenchPurge(root, plan, { dryRun: false });

    expect(result.deleted.some((p) => p.includes("stale"))).toBe(true);
    expect(existsSync(path.join(root, "missions", "m", "keep.md"))).toBe(true);
    expect(readFileSync(path.join(root, "missions", "m", "keep.md"), "utf8")).toBe("keep");
  });
});
