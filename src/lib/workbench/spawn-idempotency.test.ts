import { describe, expect, it } from "vitest";
import {
  shouldSkipSpawn,
  type OrchestratorState,
} from "../../../orchestrator/src/idempotency.js";

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
