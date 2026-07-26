import { describe, expect, it } from "vitest";
import {
  hasUniqueCompleteStatus,
  parseCheckpointStatuses,
} from "../../../orchestrator/src/checkpoint-status.js";
import {
  hasUniqueCompleteStatus as hasUniqueCompleteScriptStatus,
} from "../../../scripts/lib/checkpoint-status.mjs";

describe("checkpoint status", () => {
  it("accepts exactly one complete status line", () => {
    expect(hasUniqueCompleteStatus("# Checkpoint\n\nSTATUS: COMPLETE\n")).toBe(true);
    expect(parseCheckpointStatuses("STATUS: COMPLETE\n")).toEqual(["complete"]);
  });

  it("rejects ambiguous, blocked, partial, and inline statuses", () => {
    expect(hasUniqueCompleteStatus("STATUS: COMPLETE\nSTATUS: BLOCKED\n")).toBe(false);
    expect(hasUniqueCompleteStatus("STATUS: BLOCKED\nSTATUS: COMPLETE\n")).toBe(false);
    expect(hasUniqueCompleteStatus("STATUS: COMPLETE-ish\n")).toBe(false);
    expect(hasUniqueCompleteStatus("notes: STATUS: COMPLETE\n")).toBe(false);
  });

  it("keeps script entry points on the same fail-closed semantics", () => {
    expect(hasUniqueCompleteScriptStatus("STATUS: COMPLETE\n")).toBe(true);
    expect(
      hasUniqueCompleteScriptStatus("STATUS: COMPLETE\nSTATUS: BLOCKED\n"),
    ).toBe(false);
  });
});
