/**
 * Mission planner — Juno picks the next mission from registry + charter,
 * without human assigning each mission manually.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AutonomyDecision, AutonomyLimits, AutonomyState } from "./autonomy-types.js";
import { evaluateLoopGate } from "./loop-gate.js";
import { hasPendingBookQualityFixes, needsSelfOptimizeRun, readQualityScan } from "./self-optimize.js";

export type LoopKind =
  | "local_loop"
  | "agi_loop"
  | "book_loop"
  | "book_quality_loop"
  | "self_optimize"
  | "generic_queue";

export interface MissionSpec {
  missionId: string;
  priority: number;
  bootstrap?: string;
  loopKind: LoopKind;
  loopScript: string;
  /** All listed missions must be COMPLETE before this is eligible */
  requiresComplete?: string[];
  /** This mission must not be COMPLETE */
  requiresIncomplete?: boolean;
  /** Auto queue when eligible and not started */
  autoQueue?: boolean;
}

export interface AutonomyCharter {
  enabled?: boolean;
  charter?: string;
  autoDiscoverMissions?: boolean;
  missionPriority?: string[];
  forbiddenMissionIds?: string[];
  missionOverrides?: Record<string, Partial<Pick<MissionSpec, "priority" | "autoQueue">>>;
}

export const DEFAULT_MISSION_REGISTRY: MissionSpec[] = [
  {
    missionId: "juno-self-iterate-p2-2026",
    priority: 10,
    loopKind: "local_loop",
    loopScript: "loop:self-iterate-p2-run",
    requiresIncomplete: true,
  },
  {
    missionId: "juno-agi-literature-2026",
    priority: 20,
    bootstrap: "queue:agi-literature",
    loopKind: "agi_loop",
    loopScript: "agi:loop",
    requiresComplete: ["juno-self-iterate-p2-2026"],
    requiresIncomplete: true,
    autoQueue: true,
  },
  {
    missionId: "juno-axiom-book-2026",
    priority: 30,
    bootstrap: "queue:axiom-book",
    loopKind: "book_loop",
    loopScript: "book:loop",
    requiresComplete: ["juno-self-iterate-p2-2026", "juno-agi-literature-2026"],
    requiresIncomplete: true,
    autoQueue: true,
  },
  {
    missionId: "juno-book-quality-2026",
    priority: 40,
    bootstrap: "queue:book-quality",
    loopKind: "book_quality_loop",
    loopScript: "book:quality-loop",
    requiresComplete: ["juno-axiom-book-2026"],
    autoQueue: false,
  },
  {
    missionId: "__self_optimize__",
    priority: 45,
    loopKind: "self_optimize",
    loopScript: "self:optimize",
    requiresComplete: ["juno-axiom-book-2026"],
  },
  {
    missionId: "juno-overseer-hardening-2026",
    priority: 50,
    bootstrap: "queue:hardening",
    loopKind: "generic_queue",
    loopScript: "mission:loop",
    requiresComplete: ["juno-self-iterate-p2-2026"],
    requiresIncomplete: true,
    autoQueue: true,
  },
  {
    missionId: "juno-workbench-cleanup-2026",
    priority: 55,
    bootstrap: "queue:workbench-cleanup",
    loopKind: "generic_queue",
    loopScript: "mission:loop",
    requiresComplete: [],
    requiresIncomplete: true,
    autoQueue: false,
  },
];

function charterPath(workbench: string): string {
  return path.join(workbench, "config", "autonomy-charter.json");
}

function registryPath(workbench: string): string {
  return path.join(workbench, "config", "mission-registry.json");
}

export function loadAutonomyCharter(workbench: string): AutonomyCharter {
  const p = charterPath(workbench);
  if (!existsSync(p)) {
    return { enabled: true, autoDiscoverMissions: true };
  }
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AutonomyCharter;
  } catch {
    return { enabled: true, autoDiscoverMissions: true };
  }
}

export function loadMissionRegistry(workbench: string): MissionSpec[] {
  const p = registryPath(workbench);
  let base = DEFAULT_MISSION_REGISTRY;
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as { missions?: MissionSpec[] };
      if (raw.missions?.length) base = raw.missions;
    } catch {
      /* use default */
    }
  }
  const charter = loadAutonomyCharter(workbench);
  if (charter.missionPriority?.length) {
    const order = new Map(charter.missionPriority.map((id, i) => [id, i]));
    base = [...base].sort((a, b) => {
      const pa = order.get(a.missionId) ?? a.priority;
      const pb = order.get(b.missionId) ?? b.priority;
      return pa - pb;
    });
  }
  if (charter.missionOverrides) {
    base = base.map((spec) => {
      const o = charter.missionOverrides![spec.missionId];
      return o ? { ...spec, ...o } : spec;
    });
  }
  return base.sort((a, b) => a.priority - b.priority);
}

export function missionComplete(workbench: string, missionId: string): boolean {
  if (missionId.startsWith("__")) return false;
  const cp = path.join(workbench, "missions", missionId, "checkpoint.md");
  if (!existsSync(cp)) return false;
  return /STATUS:\s*COMPLETE/i.test(readFileSync(cp, "utf8"));
}

export function missionStarted(workbench: string, missionId: string): boolean {
  if (missionId.startsWith("__")) return true;
  return existsSync(path.join(workbench, "missions", missionId, "progress.md"));
}

export function missionHasQueuedPhases(workbench: string, missionId: string): boolean {
  const progress = path.join(workbench, "missions", missionId, "progress.md");
  if (!existsSync(progress)) return false;
  return /\|\s*queued\s*\|/i.test(readFileSync(progress, "utf8"));
}

export function queueHeadMissionId(workbench: string): string | null {
  const nowPath = path.join(workbench, "queue", "now.yaml");
  if (!existsSync(nowPath)) return null;
  const text = readFileSync(nowPath, "utf8");
  const m = text.match(/mission_id:\s*(\S+)/);
  return m?.[1] ?? null;
}

export function discoverIncompleteMissions(workbench: string): string[] {
  const missionsDir = path.join(workbench, "missions");
  if (!existsSync(missionsDir)) return [];
  const found: string[] = [];
  for (const name of readdirSync(missionsDir)) {
    if (missionComplete(workbench, name)) continue;
    if (missionHasQueuedPhases(workbench, name)) found.push(name);
  }
  return found.sort();
}

function specEligible(
  workbench: string,
  spec: MissionSpec,
  charter: AutonomyCharter,
  limits: AutonomyLimits,
): boolean {
  if (charter.enabled === false) return false;
  if (charter.forbiddenMissionIds?.includes(spec.missionId)) return false;
  if (!spec.missionId.startsWith("__") && !limits.allowedMissionIds.includes(spec.missionId)) {
    return false;
  }
  if (spec.requiresComplete?.some((id) => !missionComplete(workbench, id))) return false;
  if (spec.requiresIncomplete && missionComplete(workbench, spec.missionId)) return false;
  return true;
}

function decisionForSpec(spec: MissionSpec, reason: string): AutonomyDecision {
  switch (spec.loopKind) {
    case "local_loop":
      return {
        action: "run_local_loop",
        missionId: spec.missionId,
        script: spec.loopScript,
        reason,
      };
    case "agi_loop":
      return {
        action: "run_agi_loop",
        missionId: spec.missionId,
        script: spec.loopScript,
        reason,
      };
    case "book_loop":
      return {
        action: "run_book_loop",
        missionId: spec.missionId,
        script: spec.loopScript,
        reason,
      };
    case "book_quality_loop":
      return {
        action: "run_book_quality_loop",
        missionId: spec.missionId,
        script: spec.loopScript,
        reason,
      };
    case "self_optimize":
      return { action: "run_self_optimize", script: spec.loopScript, reason };
    case "generic_queue":
      return {
        action: "run_generic_loop",
        missionId: spec.missionId,
        script: spec.loopScript,
        reason,
      };
    default:
      return { action: "stop", reason: "unknown_loop_kind" };
  }
}

export interface PlannerInput {
  workbench: string;
  state: AutonomyState;
  limits: AutonomyLimits;
}

/** Core planner — replaces hand-assigned mission chain when charter enabled. */
export function planNextMission(input: PlannerInput): AutonomyDecision {
  const { workbench, state, limits } = input;
  const charter = loadAutonomyCharter(workbench);
  const gate = evaluateLoopGate(workbench);
  const registry = loadMissionRegistry(workbench);

  if (charter.enabled === false) {
    return { action: "stop", reason: "autonomy charter disabled" };
  }

  if (state.iterationsToday >= limits.maxSelfIterationsPerDay) {
    return {
      action: "escalate_human",
      reason: "daily_iteration_cap",
      detail: `maxSelfIterationsPerDay=${limits.maxSelfIterationsPerDay}`,
    };
  }

  // Special: book quality when scan fails (not a normal mission complete check)
  if (
    missionComplete(workbench, "juno-axiom-book-2026") &&
    hasPendingBookQualityFixes(workbench)
  ) {
    return {
      action: "run_book_quality_loop",
      missionId: "juno-book-quality-2026",
      script: "book:quality-loop",
      reason: `quality-scan: ${readQualityScan(workbench)?.failedChapters.length ?? 0} chapters need REVISE`,
    };
  }

  if (
    missionComplete(workbench, "juno-axiom-book-2026") &&
    needsSelfOptimizeRun(workbench)
  ) {
    return {
      action: "run_self_optimize",
      script: "self:optimize",
      reason: "Self-optimize tick: quality scan, rubric patch, workflow + MCP hints",
    };
  }

  // If queue has work, prefer running head mission (Juno continues what's in flight)
  const headMission = queueHeadMissionId(workbench);
  if (headMission) {
    if (!limits.allowedMissionIds.includes(headMission)) {
      return {
        action: "stop",
        reason: `queue head ${headMission} not in allowedMissionIds — fix now.yaml or charter`,
      };
    }
    const headSpec = registry.find((s) => s.missionId === headMission);
    if (headSpec && specEligible(workbench, headSpec, charter, limits)) {
      return decisionForSpec(headSpec, `queue head active — advance ${headMission}`);
    }
    return {
      action: "run_generic_loop",
      missionId: headMission,
      script: "mission:loop",
      reason: `queue head ${headMission} — generic advance`,
    };
  }

  for (const spec of registry) {
    if (spec.missionId === "__self_optimize__") continue;
    if (!specEligible(workbench, spec, charter, limits)) continue;

    const started = missionStarted(workbench, spec.missionId);
    const incomplete = !missionComplete(workbench, spec.missionId);

    if (started && incomplete) {
      return decisionForSpec(
        spec,
        `Juno autonomously continues ${spec.missionId} (charter-driven)`,
      );
    }

    if (!started && spec.autoQueue && incomplete) {
      if (state.autoQueuedToday >= limits.maxAutoQueueMissions) {
        return {
          action: "escalate_human",
          reason: "auto_queue_cap",
          detail: `Deferred auto-queue ${spec.missionId} until tomorrow`,
        };
      }
      if (spec.bootstrap) {
        return {
          action: "queue_mission",
          missionId: spec.missionId,
          bootstrap: spec.bootstrap,
          reason: `Juno self-queues ${spec.missionId} — ${charter.charter?.slice(0, 80) ?? "charter"}`,
        };
      }
    }
  }

  // Auto-discover: incomplete missions with queued phases but empty now
  if (charter.autoDiscoverMissions !== false) {
    for (const missionId of discoverIncompleteMissions(workbench)) {
      if (charter.forbiddenMissionIds?.includes(missionId)) continue;
      if (
        !limits.allowedMissionIds.includes(missionId)
      ) {
        continue;
      }
      const spec = registry.find((s) => s.missionId === missionId);
      if (spec?.bootstrap && !missionStarted(workbench, missionId)) {
        if (state.autoQueuedToday >= limits.maxAutoQueueMissions) break;
        return {
          action: "queue_mission",
          missionId,
          bootstrap: spec.bootstrap,
          reason: `Juno discovered stale mission ${missionId} — restore queue`,
        };
      }
      return {
        action: "run_generic_loop",
        missionId,
        script: "mission:loop",
        reason: `Juno discovered incomplete mission ${missionId} with queued phases`,
      };
    }
  }

  if (limits.requireLoopGateForScheduler && !gate.ok) {
    return { action: "stop", reason: `loop_gate: ${gate.reason}` };
  }

  return {
    action: "stop",
    reason: "all charter missions complete — Juno idle (edit config/autonomy-charter.json to add goals)",
  };
}

export function writePlannerSnapshot(workbench: string, decision: AutonomyDecision): void {
  const snapshot = {
    decidedAt: new Date().toISOString(),
    charter: loadAutonomyCharter(workbench).charter?.slice(0, 200),
    registry: loadMissionRegistry(workbench).map((s) => s.missionId),
    incomplete: discoverIncompleteMissions(workbench),
    decision,
  };
  mkdirSync(path.join(workbench, "state"), { recursive: true });
  writeFileSync(
    path.join(workbench, "state", "mission-planner.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
}
