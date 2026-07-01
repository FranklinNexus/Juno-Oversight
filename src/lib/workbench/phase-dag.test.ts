import { describe, expect, it } from "vitest";
import {
  canSpawnQueueItem,
  isPhaseDoneInProgress,
  validateQueueDependencies,
} from "../../../orchestrator/src/phase-dag.js";
import type { QueueItem } from "../../../orchestrator/src/types.js";

const progress = `# Progress
| si10-implement-p1 | implement | done |
| si11-review-p1 | review | queued |
`;

describe("phase-dag", () => {
  it("detects done phase in progress table", () => {
    expect(isPhaseDoneInProgress(progress, "si10-implement-p1")).toBe(true);
    expect(isPhaseDoneInProgress(progress, "si11-review-p1")).toBe(false);
  });

  it("blocks spawn when depends_on not done", () => {
    const item: QueueItem = {
      id: "juno-si11",
      horizon: "mission",
      kind: "review",
      prompt: "executor_review",
      phase_id: "si11-review-p1",
      depends_on: "si10-implement-p1",
    };
    expect(canSpawnQueueItem(item, "| si10 | x | queued |").ok).toBe(false);
    expect(canSpawnQueueItem(item, progress).ok).toBe(true);
  });

  it("validates ordered queue", () => {
    const items: QueueItem[] = [
      {
        id: "a",
        horizon: "mission",
        kind: "implement",
        prompt: "x",
        mission_id: "m",
        phase_id: "p1",
      },
      {
        id: "b",
        horizon: "mission",
        kind: "review",
        prompt: "x",
        mission_id: "m",
        phase_id: "p2",
        depends_on: "p1",
      },
    ];
    const r = validateQueueDependencies(items, () => "| p1 | implement | done |\n");
    expect(r.ok).toBe(true);
  });
});
