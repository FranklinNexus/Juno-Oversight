/** Shared bounded-autonomy types (avoids circular imports with mission-planner). */

export interface AutonomyLimits {
  maxSelfIterationsPerDay: number;
  maxAutoQueueMissions: number;
  requireLoopGateForScheduler: boolean;
  requireHumanPromoteFor: string[];
  allowedMissionIds: string[];
}

export const DEFAULT_AUTONOMY_LIMITS: AutonomyLimits = {
  maxSelfIterationsPerDay: 12,
  maxAutoQueueMissions: 2,
  requireLoopGateForScheduler: true,
  requireHumanPromoteFor: ["scheduler_enable", "vault_write", "git_destroy"],
  allowedMissionIds: [
    "juno-runtime-overnight-2026",
    "juno-von-neumann-unit-2026",
    "juno-daily-autonomy-2026",
    "juno-self-iterate-2026",
    "juno-self-iterate-p1-2026",
    "juno-self-iterate-p2-2026",
    "juno-agi-literature-2026",
    "juno-axiom-book-2026",
    "juno-book-quality-2026",
    "juno-overseer-hardening-2026",
    "juno-workbench-cleanup-2026",
  ],
};

export const BOOK_EXPERIMENT_LIMITS: AutonomyLimits = {
  ...DEFAULT_AUTONOMY_LIMITS,
  maxSelfIterationsPerDay: 24,
  maxAutoQueueMissions: 2,
};

export interface AutonomyState {
  date: string;
  iterationsToday: number;
  autoQueuedToday: number;
  lastAction?: string;
  lastDecisionAt?: string;
  lastMissionId?: string;
}

export type AutonomyDecision =
  | { action: "run_local_loop"; missionId: string; script: string; reason: string }
  | { action: "run_agi_loop"; missionId: string; script: string; reason: string }
  | { action: "run_book_loop"; missionId: string; script: string; reason: string }
  | { action: "run_book_quality_loop"; missionId: string; script: string; reason: string }
  | { action: "run_generic_loop"; missionId: string; script: string; reason: string }
  | { action: "run_self_optimize"; script: string; reason: string }
  | { action: "queue_mission"; missionId: string; bootstrap: string; reason: string }
  | { action: "stop"; reason: string }
  | { action: "escalate_human"; reason: string; detail: string };
