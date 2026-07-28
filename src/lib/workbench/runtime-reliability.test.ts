import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyChildExit } from "../../../orchestrator/src/child-process-state.js";
import { resolveJunoProjectRoot } from "../../../orchestrator/src/env.js";

describe("runtime reliability", () => {
  it("classifies a killed worker as done when run-state persisted completion", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "juno-child-state-"));
    try {
      writeFileSync(path.join(runDir, "run-state.json"), JSON.stringify({ lastStatus: "done" }));
      expect(classifyChildExit(runDir, 1)).toBe("done");
      expect(classifyChildExit(runDir, null)).toBe("done");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("classifies an unsuccessful worker without persisted completion as failed", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "juno-child-state-"));
    try {
      expect(classifyChildExit(runDir, 1)).toBe("failed");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("falls back when the configured repository root is stale", () => {
    const fallback = mkdtempSync(path.join(tmpdir(), "juno-root-fallback-"));
    try {
      expect(resolveJunoProjectRoot(path.join(fallback, "missing"), fallback)).toBe(
        path.resolve(fallback),
      );
    } finally {
      rmSync(fallback, { recursive: true, force: true });
    }
  });

  it("accepts a configured repository root with the expected structure", () => {
    const candidate = mkdtempSync(path.join(tmpdir(), "juno-root-valid-"));
    try {
      writeFileSync(path.join(candidate, "package.json"), "{}");
      mkdirSync(path.join(candidate, "orchestrator"));
      expect(resolveJunoProjectRoot(candidate, path.join(candidate, "fallback"))).toBe(
        path.resolve(candidate),
      );
    } finally {
      rmSync(candidate, { recursive: true, force: true });
    }
  });
});
