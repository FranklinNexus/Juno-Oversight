import { describe, expect, it } from "vitest";
import { shouldMarkPhaseDone } from "../../../orchestrator/src/mission-progress.js";
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

const sampleVerifyPass = `
## VERIFY_REPORT
- pnpm test: PASS
- pnpm lint: PASS
- pnpm build: PASS

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
  it("holds implement without STATUS COMPLETE", () => {
    expect(resolveQueueAdvance("implement", "")).toEqual({
      action: "hold",
      reason: "review_pending",
    });
  });

  it("requires STATUS COMPLETE and a non-empty CHANGES section for implement", () => {
    expect(resolveQueueAdvance("implement", "STATUS: COMPLETE\n")).toEqual({
      action: "hold",
      reason: "review_pending",
    });
    expect(resolveQueueAdvance("implement", "STATUS: COMPLETE\n\n## CHANGES\n\n")).toEqual({
      action: "hold",
      reason: "review_pending",
    });
    expect(
      resolveQueueAdvance("implement", "STATUS: COMPLETE\n\n## CHANGES\n- src/gate.ts\n"),
    ).toEqual({ action: "dequeue" });
    expect(
      resolveQueueAdvance(
        "implement",
        "STATUS: COMPLETE\nSTATUS: BLOCKED\n\n## CHANGES\n- src/gate.ts\n",
      ),
    ).toEqual({ action: "hold", reason: "review_pending" });
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

  it.each([
    "drift: none",
    "scope_violations: []",
    "must_fix_next_slot: []",
    "reviewer_notes: ok",
  ])("does not accept PASS when required evidence is missing: %s", (field) => {
    const incomplete = sampleVerdict
      .split("\n")
      .filter((line) => !line.includes(field))
      .join("\n");
    expect(isReviewPass(incomplete)).toBe(false);
    expect(resolveQueueAdvance("review", incomplete)).not.toEqual({ action: "dequeue" });
  });

  it("rejects REVISE without a concrete must-fix item", () => {
    const emptyRevise = sampleVerdict.replace("verdict: PASS", "verdict: REVISE");
    expect(parseReviewVerdict(emptyRevise)).toBeNull();
    expect(resolveQueueAdvance("review", emptyRevise)).toEqual({
      action: "hold",
      reason: "review_pending",
    });
  });

  it("blocks a PASS verdict with major drift", () => {
    const drifted = sampleVerdict.replace("drift: none", "drift: major");
    expect(resolveQueueAdvance("review", drifted)).toEqual({ action: "block" });
    expect(isReviewPass(drifted)).toBe(false);
    expect(isReviewBlocked(drifted)).toBe(true);
  });

  it("blocks a PASS verdict with scope violations", () => {
    const outOfScope = sampleVerdict.replace(
      "scope_violations: []",
      'scope_violations: ["src/forbidden.ts"]',
    );
    expect(resolveQueueAdvance("review", outOfScope)).toEqual({ action: "block" });
    expect(isReviewPass(outOfScope)).toBe(false);
    expect(isReviewBlocked(outOfScope)).toBe(true);
  });

  it("blocks on BLOCK verdict", () => {
    const blocked = sampleVerdict.replace("PASS", "BLOCK");
    expect(resolveQueueAdvance("review", blocked)).toEqual({ action: "block" });
    expect(isReviewBlocked(blocked)).toBe(true);
  });

  it("blocks verify slot on BLOCK verdict", () => {
    const blocked = sampleVerifyPass.replace("- verdict: PASS", "- verdict: BLOCK");
    expect(resolveQueueAdvance("verify", blocked)).toEqual({ action: "block" });
  });

  it("blocks verify slot on VERIFY_REPORT FAIL", () => {
    const failReport = `
## VERIFY_REPORT
- **FAIL**: test suite failed
`;
    expect(resolveQueueAdvance("verify", failReport)).toEqual({ action: "block" });
  });

  it.each([
    "- pnpm test: FAIL",
    "- pnpm test: failed",
    "- pnpm test: ERROR",
    "- exit code: 2",
    "- exit_code=2",
    "- process exited with code 2",
    "- process exited with status 2",
    "- command returned non-zero",
    "- verdict: BLOCK",
  ])("blocks verify slot on explicit failure evidence: %s", (result) => {
    expect(resolveQueueAdvance("verify", `## VERIFY_REPORT\n${result}\n`)).toEqual({
      action: "block",
    });
  });

  it("dequeues verify slot on PASS", () => {
    expect(resolveQueueAdvance("verify", sampleVerifyPass)).toEqual({ action: "dequeue" });
  });

  it("holds verify slot without VERIFY_REPORT", () => {
    expect(resolveQueueAdvance("verify", sampleVerdict)).toEqual({
      action: "hold",
      reason: "verify_pending",
    });
  });

  it("holds verify report without explicit PASS evidence", () => {
    expect(resolveQueueAdvance("verify", "## VERIFY_REPORT\n- pnpm test completed\n")).toEqual({
      action: "hold",
      reason: "verify_pending",
    });
  });

  it("accepts PASS with explicit zero-error evidence", () => {
    expect(
      resolveQueueAdvance(
        "verify",
        "## VERIFY_REPORT\n- pnpm test: PASS\n- exit code: 0\n- 0 errors\n",
      ),
    ).toEqual({ action: "dequeue" });
  });

  it("does not treat a successful HTTP status as a nonzero process exit", () => {
    expect(
      resolveQueueAdvance("verify", "## VERIFY_REPORT\n- endpoint status code: 200\n- PASS\n"),
    ).toEqual({ action: "dequeue" });
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

describe("shouldMarkPhaseDone", () => {
  it("marks implement done only with complete change evidence", () => {
    expect(shouldMarkPhaseDone("implement", "STATUS: COMPLETE\n")).toBe(false);
    expect(
      shouldMarkPhaseDone("implement", "STATUS: COMPLETE\n\n## CHANGES\n- src/gate.ts\n"),
    ).toBe(true);
    expect(shouldMarkPhaseDone("implement", "")).toBe(false);
  });

  it("marks review done on PASS verdict", () => {
    expect(shouldMarkPhaseDone("review", sampleVerdict)).toBe(true);
    expect(shouldMarkPhaseDone("review", "")).toBe(false);
  });

  it("marks verify done only when VERIFY_REPORT explicitly passes", () => {
    const ok = "## VERIFY_REPORT\n- pnpm test: PASS\n";
    expect(shouldMarkPhaseDone("verify", ok)).toBe(true);
    const fail = "## VERIFY_REPORT\n- **FAIL**: lint\n";
    expect(shouldMarkPhaseDone("verify", fail)).toBe(false);
    expect(shouldMarkPhaseDone("verify", "## VERIFY_REPORT\n- test completed\n")).toBe(false);
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
