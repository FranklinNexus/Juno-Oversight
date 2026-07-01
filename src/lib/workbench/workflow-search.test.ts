import { describe, expect, it } from "vitest";
import {
  scoreWorkflow,
  selectBestWorkflow,
} from "../../../orchestrator/src/workflow-search.js";

describe("workflow-search", () => {
  it("scores default workflow higher with passing signals", () => {
    const base = scoreWorkflow("default", {});
    const boosted = scoreWorkflow("default", {
      testsPass: true,
      verifyPass: true,
      safetyPass: true,
    });
    expect(boosted.score).toBeGreaterThan(base.score);
  });

  it("selects best among variants", () => {
    const best = selectBestWorkflow(["default", "self-iterate-p2"], {
      testsPass: true,
      verifyPass: true,
    });
    expect(best.workflowId).toBeTruthy();
    expect(best.score).toBeGreaterThan(0);
  });
});
