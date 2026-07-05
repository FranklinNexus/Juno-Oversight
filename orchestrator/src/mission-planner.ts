/**
 * Mission planner — Juno picks the next mission from registry + charter,
 * without human assigning each mission manually.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AutonomyDecision, AutonomyLimits, AutonomyState } from "./autonomy-types.js";
import { DEFAULT_AUTONOMY_LIMITS } from "./autonomy-types.js";
import { evaluateLoopGate } from "./loop-gate.js";
import { parseNowYaml, saveNowQueue } from "./queue-io.js";
import type { QueueItem } from "./types.js";
import { hasPendingBookQualityFixes, needsSelfOptimizeRun, readQualityScan, syncBookQualityMissionComplete } from "./self-optimize.js";
import { shouldEscalateForFitness, shouldSelfOptimizeForFitness } from "./evolution-unit.js";
import { loadConstitution } from "./constitution.js";
import { scanEnvironment, observationsToProposals } from "./drive-engine.js";

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
    missionId: "juno-runtime-overnight-2026",
    priority: 5,
    bootstrap: "queue:runtime-overnight",
    loopKind: "generic_queue",
    loopScript: "mission:loop",
    requiresComplete: [],
    requiresIncomplete: true,
    autoQueue: false,
  },
  {
    missionId: "juno-von-neumann-unit-2026",
    priority: 0,
    loopKind: "generic_queue",
    loopScript: "evolution:tick",
    requiresComplete: [],
    requiresIncomplete: true,
    autoQueue: false,
  },
  {
    missionId: "juno-agent-drive-research-2026",
    priority: 1,
    bootstrap: "queue:agent-drive-research",
    loopKind: "generic_queue",
    loopScript: "mission:loop",
    requiresComplete: [],
    requiresIncomplete: true,
    autoQueue: false,
  },
  {
    missionId: "juno-nl-brief-2026",
    priority: 10,
    bootstrap: "queue:nl-brief",
    loopKind: "generic_queue",
    loopScript: "mission:loop",
    requiresComplete: [],
    requiresIncomplete: true,
    autoQueue: false,
  },
  {
    missionId: "juno-hardware-mcp-2026",
    priority: 2,
    bootstrap: "queue:hardware-mcp",
    loopKind: "generic_queue",
    loopScript: "mission:loop",
    requiresComplete: [],
    requiresIncomplete: true,
    autoQueue: false,
  },
  {
    missionId: "juno-wisdomechoes-axiom-blog-2026",
    priority: 0,
    bootstrap: "queue:wisdomechoes-blog",
    loopKind: "generic_queue",
    loopScript: "mission:loop",
    requiresComplete: [],
    requiresIncomplete: true,
    autoQueue: false,
  },
  {
    missionId: "juno-daily-inbox-2026",
    priority: 3,
    bootstrap: "queue:daily-inbox",
    loopKind: "generic_queue",
    loopScript: "mission:loop",
    requiresComplete: ["juno-runtime-overnight-2026"],
    requiresIncomplete: true,
    autoQueue: true,
  },
  {
    missionId: "juno-daily-autonomy-2026",
    priority: 1,
    loopKind: "generic_queue",
    loopScript: "juno:daemon",
    requiresComplete: [],
    requiresIncomplete: true,
    autoQueue: false,
  },
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
    /** Charter-listed missions sort first (0..n); others sort after at 1000+priority. */
    const CHARTER_TIER = 1000;
    base = [...base].sort((a, b) => {
      const pa = order.has(a.missionId) ? order.get(a.missionId)! : CHARTER_TIER + a.priority;
      const pb = order.has(b.missionId) ? order.get(b.missionId)! : CHARTER_TIER + b.priority;
      return pa - pb;
    });
  }
  if (charter.missionOverrides) {
    base = base.map((spec) => {
      const o = charter.missionOverrides![spec.missionId];
      return o ? { ...spec, ...o } : spec;
    });
  }
  if (charter.missionPriority?.length) {
    return base;
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
  const { now } = parseNowYaml(workbench);
  return now[0]?.mission_id ?? null;
}

/** Move now items whose mission_id is outside autonomy allow-list to backlog. */
export function sanitizeAutonomyQueue(
  workbench: string,
  allowedMissionIds: string[],
): { moved: string[]; changed: boolean } {
  const allowed = new Set(allowedMissionIds);
  const { now, backlog } = parseNowYaml(workbench);
  const kept: QueueItem[] = [];
  const moved: QueueItem[] = [];
  for (const item of now) {
    if (item.mission_id && !allowed.has(item.mission_id)) {
      moved.push(item);
    } else {
      kept.push(item);
    }
  }
  if (moved.length === 0) {
    return { moved: [], changed: false };
  }
  saveNowQueue(workbench, kept, [...moved, ...backlog]);
  return { moved: moved.map((i) => i.mission_id ?? i.id), changed: true };
}

/** Meta missions skipped by auto-discover (daemon/registry covers them). */
const AUTO_DISCOVER_SKIP = new Set(["juno-daily-autonomy-2026"]);

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
  sanitizeAutonomyQueue(workbench, limits.allowedMissionIds);
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

  const fitnessEscalate = shouldEscalateForFitness(workbench);
  if (fitnessEscalate.yes) {
    return {
      action: "escalate_human",
      reason: "fitness_decline_with_api_backoff",
      detail: fitnessEscalate.detail ?? "evolution feedback",
    };
  }

  const fitnessMutate = shouldSelfOptimizeForFitness(workbench);
  if (fitnessMutate.yes) {
    return {
      action: "run_self_optimize",
      script: "self:optimize",
      reason: `Evolution v1 — ${fitnessMutate.reason ?? "fitness declining"}`,
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
    if (
      spec.missionId === "__self_optimize__" ||
      spec.missionId === "juno-daily-autonomy-2026" ||
      spec.missionId === "juno-von-neumann-unit-2026"
    ) {
      continue;
    }
    if (!specEligible(workbench, spec, charter, limits)) continue;

    const started = missionStarted(workbench, spec.missionId);
    const incomplete = !missionComplete(workbench, spec.missionId);

    if (started && incomplete) {
      if (
        spec.missionId === "juno-book-quality-2026" &&
        !hasPendingBookQualityFixes(workbench)
      ) {
        syncBookQualityMissionComplete(workbench);
        continue;
      }
      if (
        spec.loopKind === "generic_queue" &&
        !queueHeadMissionId(workbench) &&
        missionHasQueuedPhases(workbench, spec.missionId) &&
        spec.bootstrap
      ) {
        return {
          action: "queue_mission",
          missionId: spec.missionId,
          bootstrap: spec.bootstrap,
          reason: `Juno restores queue for ${spec.missionId} (phases queued, now empty)`,
        };
      }
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
      if (AUTO_DISCOVER_SKIP.has(missionId)) continue;
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
      if (spec) {
        return decisionForSpec(
          spec,
          `Juno discovered incomplete mission ${missionId} with queued phases`,
        );
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

  const driveDecision = planFromDriveEngine(workbench, state, limits);
  if (driveDecision) return driveDecision;

  return {
    action: "stop",
    reason: "all charter missions complete — Juno idle (edit config/autonomy-charter.json to add goals)",
  };
}

function planFromDriveEngine(
  workbench: string,
  state: AutonomyState,
  limits: AutonomyLimits,
): AutonomyDecision | null {
  const constitution = loadConstitution(workbench);
  if (!constitution) return null;

  const junoRoot = process.env.JUNO_OVERSIGHT_ROOT;
  if (!junoRoot) return null;
  const obs = scanEnvironment(workbench, junoRoot, constitution);
  const proposals = observationsToProposals(obs, constitution);
  const threshold = constitution.autoQueueThreshold ?? 0.55;
  const top = proposals.find((p) => p.score >= threshold && !p.needsHumanApproval);
  if (!top) {
    return {
      action: "run_drive_tick",
      reason: `Drive scan: ${obs.length} observations, no proposal above ${threshold}`,
    };
  }

  if (top.action === "bootstrap" && top.bootstrap && top.missionId) {
    if (!limits.allowedMissionIds.includes(top.missionId)) return null;
    if (state.autoQueuedToday >= limits.maxAutoQueueMissions) {
      return {
        action: "run_drive_tick",
        reason: `Drive wants ${top.missionId} but auto_queue_cap reached`,
      };
    }
    return {
      action: "queue_mission",
      missionId: top.missionId,
      bootstrap: top.bootstrap,
      reason: `Drive engine — ${top.hypothesis}`,
    };
  }

  return {
    action: "run_drive_tick",
    reason: `Drive engine — ${top.hypothesis}`,
  };
}

export function writePlannerSnapshot(workbench: string, decision: AutonomyDecision): void {
  const allowed = new Set(DEFAULT_AUTONOMY_LIMITS.allowedMissionIds);
  const snapshot = {
    decidedAt: new Date().toISOString(),
    charter: loadAutonomyCharter(workbench).charter?.slice(0, 200),
    registry: loadMissionRegistry(workbench).map((s) => s.missionId),
    incomplete: discoverIncompleteMissions(workbench).filter((id) => allowed.has(id)),
    decision,
  };
  mkdirSync(path.join(workbench, "state"), { recursive: true });
  writeFileSync(
    path.join(workbench, "state", "mission-planner.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
}
