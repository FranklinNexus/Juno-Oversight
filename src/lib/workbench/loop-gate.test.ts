import { describe, expect, it } from "vitest";
import {
  evaluateLoopGate,
  isLoopGateRequired,
  writeLoopGateStamp,
} from "../../../orchestrator/src/loop-gate.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function tempWorkbench(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "juno-loop-gate-"));
  mkdirSync(path.join(dir, "missions", "juno-smoke-loop-2026"), { recursive: true });
  mkdirSync(path.join(dir, "missions", "juno-loop-meta-2026"), { recursive: true });
  mkdirSync(path.join(dir, "state"), { recursive: true });
  writeFileSync(
    path.join(dir, "config.yaml"),
    "scheduler:\n  require_loop_gate: true\n",
    "utf8",
  );
  return dir;
}

describe("evaluateLoopGate", () => {
  it("passes when gate not required", () => {
    const wb = tempWorkbench();
    delete process.env.JUNO_REQUIRE_LOOP_GATE;
    delete process.env.JUNO_SKIP_LOOP_GATE;
    writeFileSync(path.join(wb, "config.yaml"), "scheduler:\n  require_loop_gate: false\n", "utf8");
    expect(evaluateLoopGate(wb).ok).toBe(true);
  });

  it("blocks when required and missions incomplete", () => {
    const wb = tempWorkbench();
    process.env.JUNO_SKIP_LOOP_GATE = "0";
    expect(isLoopGateRequired(wb)).toBe(true);
    const r = evaluateLoopGate(wb);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("loop_gate_blocked");
  });

  it("passes when smoke and meta checkpoints complete", () => {
    const wb = tempWorkbench();
    writeFileSync(
      path.join(wb, "missions/juno-smoke-loop-2026/checkpoint.md"),
      "STATUS: COMPLETE\n",
      "utf8",
    );
    writeFileSync(
      path.join(wb, "missions/juno-loop-meta-2026/checkpoint.md"),
      "STATUS: COMPLETE\n",
      "utf8",
    );
    expect(evaluateLoopGate(wb).ok).toBe(true);
  });

  it("passes on fresh loop-gate stamp", () => {
    const wb = tempWorkbench();
    writeLoopGateStamp(wb, "juno-smoke-loop-2026");
    expect(evaluateLoopGate(wb).ok).toBe(true);
  });
});
