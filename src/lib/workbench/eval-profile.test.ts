import { describe, expect, it } from "vitest";
import {
  normalizeEvalProfile,
  verifyStepsForProfile,
} from "../../../orchestrator/src/eval-profile.js";

describe("eval-profile", () => {
  it("defaults unknown to code", () => {
    expect(normalizeEvalProfile(undefined)).toBe("code");
    expect(normalizeEvalProfile("bogus")).toBe("code");
  });

  it("literature profile skips ui smoke", () => {
    const steps = verifyStepsForProfile("literature");
    expect(steps.some((s) => s.label === "ui_smoke")).toBe(false);
    expect(steps.some((s) => s.label === "pnpm test")).toBe(true);
  });

  it("orchestrator profile includes build", () => {
    const steps = verifyStepsForProfile("orchestrator");
    expect(steps.some((s) => s.label === "orchestrator:build")).toBe(true);
  });
});
