import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRunManifestId,
  resolveMissionDirectory,
  resolveRunDirectory,
  validateRunManifestPath,
} from "../../../orchestrator/src/workbench-paths.js";

function workbench(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "juno-paths-"));
  mkdirSync(path.join(root, "missions"), { recursive: true });
  mkdirSync(path.join(root, "runs"), { recursive: true });
  return root;
}

describe("Workbench path boundaries", () => {
  it("accepts normal ids and rejects traversal, drive prefixes, and device names", () => {
    const root = workbench();
    expect(resolveMissionDirectory(root, "mission-2026.v1")).toBe(
      path.join(root, "missions", "mission-2026.v1"),
    );
    expect(resolveRunDirectory(root, "run_2026-01")).toBe(
      path.join(root, "runs", "run_2026-01"),
    );
    expect(resolveMissionDirectory(root, "今日任务-2026")).toBe(
      path.join(root, "missions", "今日任务-2026"),
    );

    for (const invalid of [
      "",
      ".",
      "..",
      "C:",
      "run/child",
      "run\\child",
      "run.",
      " CON",
      "NUL",
      "COM¹",
    ]) {
      expect(() => resolveRunDirectory(root, invalid)).toThrow(/Invalid run id/);
      expect(() => resolveMissionDirectory(root, invalid)).toThrow(/Invalid mission id/);
    }
  });

  it("requires a real manifest directly under Workbench runs and a matching run id", () => {
    const root = workbench();
    const runDir = path.join(root, "runs", "safe-run");
    const manifestPath = path.join(runDir, "manifest.json");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ runId: "safe-run" }), "utf8");

    const location = validateRunManifestPath(root, manifestPath);
    expect(location).toMatchObject({ runId: "safe-run", runDir, manifestPath });
    expect(() => assertRunManifestId(location, "other-run")).toThrow(/does not match/);
    expect(() => assertRunManifestId(location, "safe-run")).not.toThrow();

    const outside = path.join(root, "outside", "manifest.json");
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(outside, "{}", "utf8");
    expect(() => validateRunManifestPath(root, outside)).toThrow(/outside Workbench runs/);
  });

  it("rejects a run directory junction that escapes Workbench runs", () => {
    const root = workbench();
    const outside = mkdtempSync(path.join(os.tmpdir(), "juno-run-outside-"));
    writeFileSync(path.join(outside, "manifest.json"), "{}", "utf8");
    const linkedRun = path.join(root, "runs", "linked-run");
    symlinkSync(outside, linkedRun, process.platform === "win32" ? "junction" : "dir");

    expect(() => validateRunManifestPath(root, path.join(linkedRun, "manifest.json"))).toThrow(
      /escapes Workbench runs through a link/,
    );
  });

  it("uses Windows path semantics when checking a canonical manifest path", () => {
    if (process.platform !== "win32") return;
    const root = workbench();
    const runDir = path.join(root, "runs", "case-safe-run");
    const manifestPath = path.join(runDir, "manifest.json");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ runId: "case-safe-run" }), "utf8");

    const location = validateRunManifestPath(root.toUpperCase(), manifestPath.toUpperCase());
    expect(location.runId).toBe("case-safe-run");
    expect(location.manifestPath.toLowerCase()).toBe(manifestPath.toLowerCase());
  });
});
