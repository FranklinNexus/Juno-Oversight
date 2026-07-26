/**
 * Mission planner — Juno picks the next mission from registry + charter,
 * without human assigning each mission manually.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AutonomyDecision, AutonomyLimits, AutonomyState } from "./autonomy-types.js";
import { DEFAULT_AUTONOMY_LIMITS } from "./autonomy-types.js";
import { junoProjectRoot } from "./env.js";
import { evaluateLoopGate } from "./loop-gate.js";
import { readNowQueueSnapshot, replaceQueueSnapshotConditional } from "./queue-io.js";
import type { QueueItem } from "./types.js";
import { hasPendingBookQualityFixes, needsSelfOptimizeRun, readQualityScan, syncBookQualityMissionComplete } from "./self-optimize.js";
import { shouldEscalateForFitness, shouldSelfOptimizeForFitness } from "./evolution-unit.js";
import { readMissionCompletionReceipt } from "./mission-completion.js";
import { resolveMissionDirectory } from "./workbench-paths.js";

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

export const PLANNER_ARBITRATION_POLICY = [
  "charter_and_daily_caps",
  "fitness_and_quality_gates",
  "explicit_queue_head",
  "incomplete_registry_mission",
  "eligible_auto_queue_or_discovery",
  "loop_gate",
  "drive_proposal",
  "idle",
] as const;

export const DEFAULT_MISSION_REGISTRY: MissionSpec[] = [
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

export function loadRuntimeScriptRegistry(
  projectRoot: string = junoProjectRoot(),
): ReadonlySet<string> {
  const packagePath = path.join(projectRoot, "package.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`Runtime script registry is unreadable: ${packagePath}`, { cause: error });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Runtime script registry must be a package JSON object: ${packagePath}`);
  }
  const scripts = (raw as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new Error(`Runtime script registry is missing scripts: ${packagePath}`);
  }
  const entries = Object.entries(scripts);
  if (entries.some(([name, command]) => !name.trim() || typeof command !== "string" || !command.trim())) {
    throw new Error(`Runtime script registry contains an invalid command: ${packagePath}`);
  }
  return new Set(entries.map(([name]) => name));
}

export function loadAutonomyCharter(workbench: string): AutonomyCharter {
  const p = charterPath(workbench);
  if (!existsSync(p)) {
    return { enabled: true, autoDiscoverMissions: true };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (error) {
    throw new Error(`Autonomy charter is unreadable; refusing autonomous work: ${p}`, {
      cause: error,
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Autonomy charter must be a JSON object: ${p}`);
  }
  const charter = raw as AutonomyCharter;
  if (
    (charter.enabled !== undefined && typeof charter.enabled !== "boolean") ||
    (charter.autoDiscoverMissions !== undefined &&
      typeof charter.autoDiscoverMissions !== "boolean") ||
    (charter.missionPriority !== undefined &&
      (!Array.isArray(charter.missionPriority) ||
        charter.missionPriority.some((id) => typeof id !== "string" || !id.trim()))) ||
    (charter.forbiddenMissionIds !== undefined &&
      (!Array.isArray(charter.forbiddenMissionIds) ||
        charter.forbiddenMissionIds.some((id) => typeof id !== "string" || !id.trim()))) ||
    (charter.missionOverrides !== undefined &&
      (!charter.missionOverrides ||
        typeof charter.missionOverrides !== "object" ||
        Array.isArray(charter.missionOverrides) ||
        Object.values(charter.missionOverrides).some(
          (override) =>
            !override ||
            typeof override !== "object" ||
            (override.priority !== undefined && !Number.isFinite(override.priority)) ||
            (override.autoQueue !== undefined && typeof override.autoQueue !== "boolean"),
        )))
  ) {
    throw new Error(`Autonomy charter has invalid governance fields: ${p}`);
  }
  for (const id of [
    ...(charter.missionPriority ?? []),
    ...(charter.forbiddenMissionIds ?? []),
    ...Object.keys(charter.missionOverrides ?? {}),
  ]) {
    resolveMissionDirectory(workbench, id);
  }
  return charter;
}

export function loadMissionRegistry(workbench: string): MissionSpec[] {
  const p = registryPath(workbench);
  let base: MissionSpec[] = [...DEFAULT_MISSION_REGISTRY];
  if (existsSync(p)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(p, "utf8"));
    } catch (error) {
      throw new Error(`Mission registry is unreadable; refusing autonomous work: ${p}`, {
        cause: error,
      });
    }
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { missions?: unknown }).missions)) {
      throw new Error(`Mission registry must contain a missions array: ${p}`);
    }
    const missions = (raw as { missions: MissionSpec[] }).missions;
    const loopKinds = new Set<LoopKind>([
      "local_loop",
      "agi_loop",
      "book_loop",
      "book_quality_loop",
      "self_optimize",
      "generic_queue",
    ]);
    const valid = missions.every(
      (mission) =>
        mission &&
        typeof mission.missionId === "string" &&
        Boolean(mission.missionId.trim()) &&
        Number.isFinite(mission.priority) &&
        loopKinds.has(mission.loopKind) &&
        typeof mission.loopScript === "string" &&
        Boolean(mission.loopScript.trim()) &&
        (mission.requiresComplete === undefined ||
          (Array.isArray(mission.requiresComplete) &&
            mission.requiresComplete.every((id) => typeof id === "string" && Boolean(id.trim())))) &&
        (mission.requiresIncomplete === undefined ||
          typeof mission.requiresIncomplete === "boolean") &&
        (mission.autoQueue === undefined || typeof mission.autoQueue === "boolean"),
    );
    if (!valid || new Set(missions.map((mission) => mission.missionId)).size !== missions.length) {
      throw new Error(`Mission registry contains invalid or duplicate mission entries: ${p}`);
    }
    for (const mission of missions) {
      if (mission.missionId !== "__self_optimize__") {
        resolveMissionDirectory(workbench, mission.missionId);
      }
      for (const required of mission.requiresComplete ?? []) {
        resolveMissionDirectory(workbench, required);
      }
    }
    base = [...missions];
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
  return [...base].sort((a, b) => a.priority - b.priority);
}

export function missionComplete(workbench: string, missionId: string): boolean {
  if (missionId.startsWith("__")) return false;
  return readMissionCompletionReceipt(workbench, missionId) !== null;
}

export function missionStarted(workbench: string, missionId: string): boolean {
  if (missionId.startsWith("__")) return true;
  return existsSync(path.join(resolveMissionDirectory(workbench, missionId), "progress.md"));
}

export function missionHasQueuedPhases(workbench: string, missionId: string): boolean {
  const progress = path.join(resolveMissionDirectory(workbench, missionId), "progress.md");
  if (!existsSync(progress)) return false;
  return /\|\s*queued\s*\|/i.test(readFileSync(progress, "utf8"));
}

export function queueHeadMissionId(workbench: string): string | null {
  const { now } = readNowQueueSnapshot(workbench);
  return now[0]?.mission_id ?? null;
}

/** Move now items whose mission_id is outside autonomy allow-list to backlog. */
export function sanitizeAutonomyQueue(
  workbench: string,
  allowedMissionIds: string[],
): { moved: string[]; changed: boolean } {
  const allowed = new Set(allowedMissionIds);
  const queueSnapshot = readNowQueueSnapshot(workbench);
  const { now, backlog } = queueSnapshot;
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
  const update = replaceQueueSnapshotConditional(workbench, {
    expectedRevision: queueSnapshot.revision,
    now: kept,
    backlog: [...moved, ...backlog],
  });
  if (!update.ok) throw new Error(`Autonomy queue sanitization failed: ${update.reason}`);
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

export function decisionForSpec(
  spec: MissionSpec,
  reason: string,
  runtimeScripts: ReadonlySet<string> = loadRuntimeScriptRegistry(),
): AutonomyDecision {
  if (!runtimeScripts.has(spec.loopScript)) {
    return {
      action: "escalate_human",
      reason: "runtime_script_unavailable",
      detail: `${spec.missionId} requires unavailable runtime script ${spec.loopScript}`,
    };
  }
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
  const runtimeScripts = loadRuntimeScriptRegistry();

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
    if (headSpec) {
      if (!specEligible(workbench, headSpec, charter, limits)) {
        return {
          action: "stop",
          reason: `queue head ${headMission} is not eligible under charter or mission dependencies`,
        };
      }
      return decisionForSpec(
        headSpec,
        `queue head active — advance ${headMission}`,
        runtimeScripts,
      );
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
        runtimeScripts,
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
          runtimeScripts,
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

  return {
    action: "stop",
    reason: "all charter missions complete — Juno idle (edit config/autonomy-charter.json to add goals)",
  };
}

export function writePlannerSnapshot(workbench: string, decision: AutonomyDecision): void {
  const allowed = new Set(DEFAULT_AUTONOMY_LIMITS.allowedMissionIds);
  const snapshot = {
    decidedAt: new Date().toISOString(),
    arbitrationPolicy: PLANNER_ARBITRATION_POLICY,
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
