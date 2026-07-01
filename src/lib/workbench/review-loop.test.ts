import { describe, expect, it } from "vitest";
import {
  isReviewBlocked,
  isReviewPass,
  parseReviewVerdict,
  resolveQueueAdvance,
  validateReviewAlternation,
} from "../../../orchestrator/src/review-loop.js";

const sampleVerdict = `
## REVIEW_VERDICT
- verdict: PASS
- drift: none
- scope_violations: []
- must_fix_next_slot: []
- reviewer_notes: ok
`;

describe("parseReviewVerdict", () => {
  it("parses PASS verdict fields", () => {
    const parsed = parseReviewVerdict(sampleVerdict);
    expect(parsed?.verdict).toBe("PASS");
    expect(parsed?.drift).toBe("none");
    expect(parsed?.scopeViolations).toEqual([]);
    expect(parsed?.mustFixNextSlot).toEqual([]);
    expect(parsed?.reviewerNotes).toBe("ok");
  });

  it("returns null when section is missing", () => {
    expect(parseReviewVerdict("# Checkpoint\n\n## 进度\n")).toBeNull();
  });
});

describe("resolveQueueAdvance", () => {
  it("dequeues after implement without verdict", () => {
    expect(resolveQueueAdvance("implement", "")).toEqual({ action: "dequeue" });
  });

  it("holds review slot until PASS", () => {
    expect(resolveQueueAdvance("review", "")).toEqual({
      action: "hold",
      reason: "review_pending",
    });
    expect(isReviewPass("")).toBe(false);
  });

  it("dequeues review slot on PASS", () => {
    expect(resolveQueueAdvance("review", sampleVerdict)).toEqual({ action: "dequeue" });
    expect(isReviewPass(sampleVerdict)).toBe(true);
    expect(isReviewBlocked(sampleVerdict)).toBe(false);
  });

  it("blocks on BLOCK verdict", () => {
    const blocked = sampleVerdict.replace("PASS", "BLOCK");
    expect(resolveQueueAdvance("review", blocked)).toEqual({ action: "block" });
    expect(isReviewBlocked(blocked)).toBe(true);
  });

  it("blocks verify slot on BLOCK verdict", () => {
    const blocked = sampleVerdict.replace("PASS", "BLOCK");
    expect(resolveQueueAdvance("verify", blocked)).toEqual({ action: "block" });
  });

  it("blocks verify slot on VERIFY_REPORT FAIL", () => {
    const failReport = `
## VERIFY_REPORT
- **FAIL**: test suite failed
`;
    expect(resolveQueueAdvance("verify", failReport)).toEqual({ action: "block" });
  });

  it("dequeues verify slot on PASS", () => {
    expect(resolveQueueAdvance("verify", sampleVerdict)).toEqual({ action: "dequeue" });
  });

  it("returns revise action with must_fix list", () => {
    const revise = `
## REVIEW_VERDICT
- verdict: REVISE
- drift: minor
- scope_violations: []
- must_fix_next_slot: ["fix tests"]
- reviewer_notes: retry
`;
    expect(resolveQueueAdvance("review", revise)).toEqual({
      action: "revise",
      mustFix: ["fix tests"],
    });
  });
});

describe("validateReviewAlternation", () => {
  it("accepts implement followed by review", () => {
    expect(
      validateReviewAlternation([
        { run_kind: "implement" },
        { run_kind: "review" },
        { run_kind: "implement" },
      ]),
    ).toBe(true);
  });

  it("rejects implement followed by implement", () => {
    expect(
      validateReviewAlternation([{ run_kind: "implement" }, { run_kind: "implement" }]),
    ).toBe(false);
  });
});
