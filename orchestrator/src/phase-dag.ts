import type { QueueItem } from "./types.js";

export interface PhaseDagNode {
  phaseId: string;
  dependsOn?: string;
}

/** Whether progress.md marks a phase row as done. */
export function isPhaseDoneInProgress(progressText: string, phaseId: string): boolean {
  const escaped = phaseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\|\\s*${escaped}\\s*\\|[^\\n]*\\|\\s*done\\s*\\|`, "i");
  return re.test(progressText);
}

export function queueItemDependsOn(item: QueueItem): string | undefined {
  return item.depends_on?.trim() || undefined;
}

/** True when queue head's dependency (if any) is satisfied in mission progress. */
export function canSpawnQueueItem(
  item: QueueItem,
  progressText: string,
): { ok: boolean; reason?: string } {
  const dep = queueItemDependsOn(item);
  if (!dep) return { ok: true };
  if (isPhaseDoneInProgress(progressText, dep)) return { ok: true };
  return {
    ok: false,
    reason: `phase ${item.phase_id} blocked: depends_on ${dep} not done`,
  };
}

/** Validate entire now queue respects dependency order (earlier items must satisfy deps). */
export function validateQueueDependencies(
  items: QueueItem[],
  progressForMission: (missionId: string) => string,
): { ok: boolean; blockedId?: string; reason?: string } {
  const simulatedDone = new Set<string>();

  for (const item of items) {
    const progress = item.mission_id ? progressForMission(item.mission_id) : "";
    for (const [phaseId] of progress.matchAll(/\|\s*([^\s|]+)\s*\|[^|\n]*\|\s*done\s*\|/gi)) {
      simulatedDone.add(phaseId);
    }

    const dep = queueItemDependsOn(item);
    if (dep && !simulatedDone.has(dep) && !isPhaseDoneInProgress(progress, dep)) {
      return {
        ok: false,
        blockedId: item.id,
        reason: `depends_on ${dep} not done before ${item.id}`,
      };
    }
    simulatedDone.add(item.phase_id ?? item.id);
  }

  return { ok: true };
}

export function buildPhaseDag(items: QueueItem[]): PhaseDagNode[] {
  return items
    .filter((i) => i.phase_id)
    .map((i) => ({ phaseId: i.phase_id!, dependsOn: queueItemDependsOn(i) }));
}
