import { readNowQueueSnapshot, replaceQueueSnapshotConditional } from "./queue-io.js";
import type { QueueItem } from "./types.js";

export interface PromoteResult {
  promoted: QueueItem[];
  now: QueueItem[];
  backlog: QueueItem[];
}

/** Move first N backlog items to the tail of `now`. */
export function promoteBacklogToNow(workbench: string, count: number): PromoteResult {
  const queueSnapshot = readNowQueueSnapshot(workbench);
  const { now, backlog } = queueSnapshot;
  const n = Math.max(0, Math.min(count, backlog.length));
  const promoted = backlog.slice(0, n);
  const remaining = backlog.slice(n);
  const nextNow = [...now, ...promoted];
  const update = replaceQueueSnapshotConditional(workbench, {
    expectedRevision: queueSnapshot.revision,
    now: nextNow,
    backlog: remaining,
  });
  if (!update.ok) throw new Error(`Backlog promotion failed: ${update.reason}`);
  return { promoted, now: nextNow, backlog: remaining };
}

/** Promote backlog items matching mission_id (preserves order). */
export function promoteMissionFromBacklog(
  workbench: string,
  missionId: string,
): PromoteResult {
  const queueSnapshot = readNowQueueSnapshot(workbench);
  const { now, backlog } = queueSnapshot;
  const promoted = backlog.filter((item) => item.mission_id === missionId);
  const remaining = backlog.filter((item) => item.mission_id !== missionId);
  const nextNow = [...now, ...promoted];
  const update = replaceQueueSnapshotConditional(workbench, {
    expectedRevision: queueSnapshot.revision,
    now: nextNow,
    backlog: remaining,
  });
  if (!update.ok) throw new Error(`Mission backlog promotion failed: ${update.reason}`);
  return { promoted, now: nextNow, backlog: remaining };
}
