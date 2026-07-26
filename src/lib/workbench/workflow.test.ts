import { describe, expect, it } from "vitest";
import {
  compileWorkflowSlots,
  listWorkflowIds,
  loadWorkflow,
  parseWorkflowDefinition,
} from "../../../orchestrator/src/workflow.js";

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
    expect(ids).toContain("variants/default-debate-v2");
  });

  it("strictly validates definitions and variant selectors", () => {
    expect(loadWorkflow("variants/default-debate-v2").slots).toHaveLength(4);
    expect(() => loadWorkflow("../package")).toThrow(/selector/i);
    expect(() =>
      parseWorkflowDefinition({
        id: "bad",
        version: 1,
        description: "bad workflow",
        evalProfile: "unknown",
        slots: [{ kind: "implement", prompt: "executor_implement" }],
      }),
    ).toThrow(/evalProfile/i);
    expect(() =>
      parseWorkflowDefinition({
        id: "bad-dependency",
        version: 1,
        description: "bad dependency",
        evalProfile: "code",
        slots: [{ kind: "verify", prompt: "executor_verify", dependsOn: "later" }],
      }),
    ).toThrow(/earlier slot/i);
  });

  it("compiles workflow slots into isolated experiment queue items", () => {
    const promptSha256ByTemplate = {
      executor_implement: "b".repeat(64),
      executor_review: "c".repeat(64),
      executor_verify: "d".repeat(64),
    };
    const items = compileWorkflowSlots({
      experimentId: "experiment-one",
      arm: "candidate",
      episode: 2,
      missionId: "juno-workflow-canary-test",
      sourcePhaseId: "source-phase",
      fixtureSha256: "a".repeat(64),
      promptSha256ByTemplate,
      workflowId: "default",
    });
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
    expect(items.map((item) => item.run_kind)).toEqual(["implement", "review", "verify"]);
    expect(items[0]).toMatchObject({
      experiment_id: "experiment-one",
      experiment_arm: "candidate",
      experiment_episode: 2,
      source_phase_id: "source-phase",
      experiment_fixture_sha256: "a".repeat(64),
      experiment_prompt_sha256: promptSha256ByTemplate.executor_implement,
      workflow_id: "default",
    });
    expect(items.map((item) => item.experiment_prompt_sha256)).toEqual([
      promptSha256ByTemplate.executor_implement,
      promptSha256ByTemplate.executor_review,
      promptSha256ByTemplate.executor_verify,
    ]);
    expect(items[1].depends_on).toBe(items[0].phase_id);
    expect(items[2].depends_on).toBe(items[1].phase_id);
  });

  it("refuses missing or malformed experiment prompt hashes", () => {
    const input = {
      experimentId: "experiment-one",
      arm: "candidate" as const,
      episode: 2,
      missionId: "juno-workflow-canary-test",
      sourcePhaseId: "source-phase",
      fixtureSha256: "a".repeat(64),
      workflowId: "default",
      promptSha256ByTemplate: {
        executor_implement: "b".repeat(64),
        executor_review: "c".repeat(64),
        executor_verify: "d".repeat(64),
      },
    };
    expect(() => compileWorkflowSlots({
      ...input,
      promptSha256ByTemplate: {
        executor_implement: "b".repeat(64),
        executor_review: "c".repeat(64),
      },
    })).toThrow(/missing workflow template: executor_verify/i);
    expect(() => compileWorkflowSlots({
      ...input,
      promptSha256ByTemplate: {
        ...input.promptSha256ByTemplate,
        executor_verify: "not-a-hash",
      },
    })).toThrow(/executor_verify must be SHA-256/i);
  });

  it("compiles from one validated prompt hash snapshot", () => {
    let implementHashReads = 0;
    const promptSha256ByTemplate = {
      get executor_implement() {
        implementHashReads += 1;
        return implementHashReads === 1 ? "b".repeat(64) : "changed-after-validation";
      },
      executor_review: "c".repeat(64),
      executor_verify: "d".repeat(64),
    };
    const items = compileWorkflowSlots({
      experimentId: "experiment-snapshot",
      arm: "baseline",
      episode: 1,
      missionId: "juno-workflow-canary-test",
      sourcePhaseId: "source-phase",
      fixtureSha256: "a".repeat(64),
      workflowId: "default",
      promptSha256ByTemplate,
    });

    expect(implementHashReads).toBe(1);
    expect(items[0].experiment_prompt_sha256).toBe("b".repeat(64));
  });
});
