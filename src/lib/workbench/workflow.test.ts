import { describe, expect, it } from "vitest";
import { listWorkflowIds, loadWorkflow } from "../../../orchestrator/src/workflow.js";

describe("workflow", () => {
  it("loads default workflow with three slots", () => {
    const wf = loadWorkflow("default");
    expect(wf.slots).toHaveLength(3);
    expect(wf.slots.map((s) => s.kind)).toEqual(["implement", "review", "verify"]);
  });

  it("self-iterate workflow uses orchestrator eval profile", () => {
    const wf = loadWorkflow("self-iterate");
    expect(wf.evalProfile).toBe("orchestrator");
    expect(wf.id).toBe("self-iterate-p0");
  });

  it("lists bundled workflow ids", () => {
    const ids = listWorkflowIds();
    expect(ids).toContain("default");
    expect(ids).toContain("self-iterate");
  });
});
