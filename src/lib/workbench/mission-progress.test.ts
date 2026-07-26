import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReviseImplementItem,
  nextRevisionAttempt,
} from "../../../orchestrator/src/mission-progress.js";
import { revisionFixRunId } from "../../../orchestrator/src/revision-lineage.js";
import type { QueueItem } from "../../../orchestrator/src/types.js";

describe("buildReviseImplementItem", () => {
  it("rebinds a generic workflow experiment revision to its implement prompt", () => {
    const reviewPromptSha256 = "b".repeat(64);
    const implementPromptSha256 = "c".repeat(64);
    const reviewItem: QueueItem = {
      id: "wfexp-review",
      horizon: "mission",
      kind: "review",
      run_kind: "review",
      repo_target: "workbench",
      prompt: "executor_book_review",
      provider: "openai_codex",
      mission_id: "juno-workflow-canary-sample",
      phase_id: "candidate-review",
      workflow_id: "variants/axiom-book-lean-v2",
      eval_profile: "literature",
      experiment_id: "wfexp-review-binding",
      experiment_arm: "candidate",
      experiment_episode: 2,
      source_phase_id: "book-workflow-canary",
      experiment_fixture_sha256: "a".repeat(64),
      experiment_prompt_sha256: reviewPromptSha256,
    };

    const fix = buildReviseImplementItem(
      reviewItem,
      2,
      ["fix the evidence"],
      {
        experimentId: reviewItem.experiment_id!,
        promptSha256ByTemplate: {
          executor_book_review: reviewPromptSha256,
          executor_book_write: implementPromptSha256,
        },
      },
    );

    expect(fix).toMatchObject({
      id: revisionFixRunId(reviewItem.id, 2),
      kind: "implement",
      run_kind: "implement",
      repo_target: "workbench",
      prompt: "executor_book_write",
      provider: "openai_codex",
      mission_id: reviewItem.mission_id,
      phase_id: reviewItem.phase_id,
      workflow_id: reviewItem.workflow_id,
      eval_profile: reviewItem.eval_profile,
      experiment_id: reviewItem.experiment_id,
      experiment_arm: reviewItem.experiment_arm,
      experiment_episode: reviewItem.experiment_episode,
      source_phase_id: reviewItem.source_phase_id,
      experiment_fixture_sha256: reviewItem.experiment_fixture_sha256,
      experiment_prompt_sha256: implementPromptSha256,
      revision_of: reviewItem.id,
      revision_attempt: 2,
    });
  });

  it("keeps the unified literature canary prompt binding", () => {
    const promptSha256 = "d".repeat(64);
    const reviewItem: QueueItem = {
      id: "wfexp-literature-review",
      horizon: "mission",
      kind: "review",
      run_kind: "review",
      repo_target: "workbench",
      prompt: "workflow_canary_literature_v1",
      provider: "openai_codex",
      mission_id: "juno-workflow-canary-literature",
      phase_id: "candidate-review",
      workflow_id: "variants/axiom-book-lean-v2",
      eval_profile: "literature",
      experiment_id: "wfexp-literature-binding",
      experiment_arm: "candidate",
      experiment_episode: 1,
      source_phase_id: "book-workflow-canary",
      experiment_fixture_sha256: "a".repeat(64),
      experiment_prompt_sha256: promptSha256,
    };

    const fix = buildReviseImplementItem(reviewItem, 1, [], {
      experimentId: reviewItem.experiment_id!,
      promptSha256ByTemplate: {
        workflow_canary_literature_v1: promptSha256,
      },
    });

    expect(fix.prompt).toBe(reviewItem.prompt);
    expect(fix.experiment_prompt_sha256).toBe(promptSha256);
  });

  it("keeps a failed book implement slot on the book writer prompt", () => {
    const parent: QueueItem = {
      id: "book-write-parent",
      horizon: "mission",
      kind: "implement",
      run_kind: "implement",
      repo_target: "workbench",
      prompt: "executor_book_write",
      mission_id: "juno-axiom-book-2026",
      phase_id: "ax-ch-write",
    };

    const fix = buildReviseImplementItem(parent, 1, ["repair chapter evidence"]);

    expect(fix).toMatchObject({
      prompt: "executor_book_write",
      repo_target: "workbench",
      revision_of: parent.id,
      revision_attempt: 1,
    });
  });

  it("fails closed without the exact proposal prompt binding", () => {
    const reviewPromptSha256 = "e".repeat(64);
    const reviewItem: QueueItem = {
      id: "wfexp-generic-review",
      horizon: "mission",
      kind: "review",
      run_kind: "review",
      repo_target: "workbench",
      prompt: "executor_review",
      provider: "openai_codex",
      mission_id: "juno-workflow-canary-generic",
      phase_id: "candidate-review",
      workflow_id: "self-iterate-p1",
      eval_profile: "orchestrator",
      experiment_id: "wfexp-generic-binding",
      experiment_arm: "candidate",
      experiment_episode: 1,
      source_phase_id: "generic-workflow-canary",
      experiment_fixture_sha256: "f".repeat(64),
      experiment_prompt_sha256: reviewPromptSha256,
    };

    expect(() => buildReviseImplementItem(reviewItem, 1)).toThrow(
      /requires an immutable proposal prompt binding/i,
    );
    expect(() => buildReviseImplementItem(reviewItem, 1, [], {
      experimentId: "another-experiment",
      promptSha256ByTemplate: {
        executor_review: reviewPromptSha256,
        executor_implement: "1".repeat(64),
      },
    })).toThrow(/does not match its parent experiment/i);
    expect(() => buildReviseImplementItem(reviewItem, 1, [], {
      experimentId: reviewItem.experiment_id!,
      promptSha256ByTemplate: {
        executor_review: "2".repeat(64),
        executor_implement: "1".repeat(64),
      },
    })).toThrow(/parent prompt binding does not match/i);
    expect(() => buildReviseImplementItem(reviewItem, 1, [], {
      experimentId: reviewItem.experiment_id!,
      promptSha256ByTemplate: {
        executor_review: reviewPromptSha256,
      },
    })).toThrow(/missing revision prompt template/i);
  });

  it("reuses the same attempt until a queue item or run directory occupies it", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-revision-attempt-"));
    const parentRunId = "parent-review-run";
    expect(nextRevisionAttempt(workbench, parentRunId)).toBe(1);
    expect(nextRevisionAttempt(workbench, parentRunId)).toBe(1);

    const first = buildReviseImplementItem({
      id: parentRunId,
      horizon: "mission",
      kind: "review",
      run_kind: "review",
      prompt: "executor_review",
    }, 1);
    expect(nextRevisionAttempt(workbench, parentRunId, [first])).toBe(2);

    mkdirSync(path.join(workbench, "runs", revisionFixRunId(parentRunId, 1)), {
      recursive: true,
    });
    expect(nextRevisionAttempt(workbench, parentRunId)).toBe(2);
  });
});
