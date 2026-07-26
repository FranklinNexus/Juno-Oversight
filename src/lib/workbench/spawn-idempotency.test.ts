import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mergeOrchestratorState,
  ORCHESTRATOR_RUN_STATUSES,
  readOrchestratorState,
  shouldSkipSpawn,
  type OrchestratorState,
} from "../../../orchestrator/src/idempotency.js";

describe("orchestrator state persistence", () => {
  it("defaults only when the state file is absent", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-orchestrator-state-"));
    expect(readOrchestratorState(workbench)).toEqual({});

    mkdirSync(path.join(workbench, "state"), { recursive: true });
    writeFileSync(path.join(workbench, "state", "orchestrator.json"), "{broken", "utf8");
    expect(() => readOrchestratorState(workbench)).toThrow(/Unable to read orchestrator state/);
  });

  it("rejects malformed fields instead of erasing control evidence", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-orchestrator-state-"));
    mkdirSync(path.join(workbench, "state"), { recursive: true });
    writeFileSync(
      path.join(workbench, "state", "orchestrator.json"),
      JSON.stringify({ activeRunId: 42, activeRunStatus: "blocked" }),
      "utf8",
    );
    expect(() => mergeOrchestratorState(workbench, { activeRunStatus: "idle" })).toThrow(
      /activeRunId/,
    );
    expect(JSON.parse(readFileSync(path.join(workbench, "state", "orchestrator.json"), "utf8")))
      .toEqual({ activeRunId: 42, activeRunStatus: "blocked" });
  });

  it("accepts only the explicit active-run status enum", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-orchestrator-status-"));
    const stateDir = path.join(workbench, "state");
    const statePath = path.join(stateDir, "orchestrator.json");
    mkdirSync(stateDir, { recursive: true });

    for (const activeRunStatus of ORCHESTRATOR_RUN_STATUSES) {
      writeFileSync(statePath, JSON.stringify({ activeRunStatus }), "utf8");
      expect(readOrchestratorState(workbench).activeRunStatus).toBe(activeRunStatus);
    }

    for (const activeRunStatus of ["", "finished", "error", "Running", 1]) {
      writeFileSync(statePath, JSON.stringify({ activeRunStatus }), "utf8");
      expect(() => readOrchestratorState(workbench)).toThrow(/activeRunStatus/);
    }
  });
});

describe("shouldSkipSpawn", () => {
  it("skips when the same run is already active", () => {
    const state: OrchestratorState = {
      activeRunId: "juno-h03-idempotency",
      activeRunStatus: "running",
      lastRunId: "juno-h03-idempotency",
    };
    expect(shouldSkipSpawn("juno-h03-idempotency", state)).toBe("active_running");
  });

  it("skips when lastRunId matches a completed run", () => {
    const state: OrchestratorState = {
      activeRunId: null,
      activeRunStatus: "idle",
      lastRunId: "juno-h03-idempotency",
    };
    expect(shouldSkipSpawn("juno-h03-idempotency", state)).toBe("last_run_dedup");
  });

  it("allows retry after failed or stall status", () => {
    for (const activeRunStatus of ["failed", "stall"] as const) {
      const state: OrchestratorState = {
        activeRunId: "juno-h03-idempotency",
        activeRunStatus,
        lastRunId: "juno-h03-idempotency",
      };
      expect(shouldSkipSpawn("juno-h03-idempotency", state)).toBeNull();
    }
  });

  it("allows spawning a different runId", () => {
    const state: OrchestratorState = {
      activeRunId: "juno-h02-review-quality",
      activeRunStatus: "done",
      lastRunId: "juno-h02-review-quality",
    };
    expect(shouldSkipSpawn("juno-h03-idempotency", state)).toBeNull();
  });
});
