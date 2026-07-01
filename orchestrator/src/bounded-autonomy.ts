import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { evaluateLoopGate } from "./loop-gate.js";

/** Hard limits on Juno self-decision (never bypass without human). */
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
    "juno-self-iterate-2026",
    "juno-self-iterate-p1-2026",
    "juno-self-iterate-p2-2026",
    "juno-agi-literature-2026",
    "juno-axiom-book-2026",
  ],
};

/** Higher cap for long-form book experiment (still bounded). */
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
  | { action: "queue_mission"; missionId: string; bootstrap: string; reason: string }
  | { action: "stop"; reason: string }
  | { action: "escalate_human"; reason: string; detail: string };

function statePath(workbench: string): string {
  return path.join(workbench, "state", "bounded-autonomy.json");
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function readAutonomyState(workbench: string): AutonomyState {
  const p = statePath(workbench);
  if (!existsSync(p)) {
    return { date: todayUtc(), iterationsToday: 0, autoQueuedToday: 0 };
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as AutonomyState;
    if (raw.date !== todayUtc()) {
      return { date: todayUtc(), iterationsToday: 0, autoQueuedToday: 0 };
    }
    return raw;
  } catch {
    return { date: todayUtc(), iterationsToday: 0, autoQueuedToday: 0 };
  }
}

export function writeAutonomyState(workbench: string, state: AutonomyState): void {
  mkdirSync(path.join(workbench, "state"), { recursive: true });
  writeFileSync(statePath(workbench), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function missionComplete(workbench: string, missionId: string): boolean {
  const cp = path.join(workbench, "missions", missionId, "checkpoint.md");
  if (!existsSync(cp)) return false;
  return /STATUS:\s*COMPLETE/i.test(readFileSync(cp, "utf8"));
}

function missionStarted(workbench: string, missionId: string): boolean {
  return existsSync(path.join(workbench, "missions", missionId, "progress.md"));
}

function limitsForWorkbench(workbench: string, base: AutonomyLimits): AutonomyLimits {
  if (missionStarted(workbench, "juno-axiom-book-2026") && !missionComplete(workbench, "juno-axiom-book-2026")) {
    return BOOK_EXPERIMENT_LIMITS;
  }
  return base;
}

/**
 * Bounded self-decision: what Juno may do next without human approval.
 * Escalates when limits hit or action not in allowlist.
 */
export function decideNextAction(
  workbench: string,
  limits: AutonomyLimits = DEFAULT_AUTONOMY_LIMITS,
): AutonomyDecision {
  const effective = limitsForWorkbench(workbench, limits);
  const state = readAutonomyState(workbench);
  const gate = evaluateLoopGate(workbench);

  if (state.iterationsToday >= effective.maxSelfIterationsPerDay) {
    return {
      action: "escalate_human",
      reason: "daily_iteration_cap",
      detail: `maxSelfIterationsPerDay=${effective.maxSelfIterationsPerDay}`,
    };
  }

  if (!missionComplete(workbench, "juno-self-iterate-p2-2026")) {
    if (effective.allowedMissionIds.includes("juno-self-iterate-p2-2026")) {
      return {
        action: "run_local_loop",
        missionId: "juno-self-iterate-p2-2026",
        script: "loop:self-iterate-p2-run",
        reason: "P2 not complete — continue self-iterate",
      };
    }
  }

  const agiDone = missionComplete(workbench, "juno-agi-literature-2026");
  const agiStarted = missionStarted(workbench, "juno-agi-literature-2026");

  if (!agiDone && agiStarted) {
    if (effective.allowedMissionIds.includes("juno-agi-literature-2026")) {
      return {
        action: "run_agi_loop",
        missionId: "juno-agi-literature-2026",
        script: "agi:loop",
        reason: "AGI literature in progress — advance queue without human '继续'",
      };
    }
  }

  if (!agiDone && !agiStarted) {
    if (state.autoQueuedToday >= effective.maxAutoQueueMissions) {
      return {
        action: "escalate_human",
        reason: "auto_queue_cap",
        detail: "Approve queue:agi-literature to start 1000-paper AGI mission",
      };
    }
    if (effective.allowedMissionIds.includes("juno-agi-literature-2026")) {
      return {
        action: "queue_mission",
        missionId: "juno-agi-literature-2026",
        bootstrap: "queue:agi-literature",
        reason:
          "P2 complete — bounded next step: 1000-paper AGI literature → preliminary AGI north-star",
      };
    }
  }

  const bookDone = missionComplete(workbench, "juno-axiom-book-2026");
  const bookStarted = missionStarted(workbench, "juno-axiom-book-2026");

  if (!bookDone && bookStarted) {
    if (effective.allowedMissionIds.includes("juno-axiom-book-2026")) {
      return {
        action: "run_book_loop",
        missionId: "juno-axiom-book-2026",
        script: "book:loop",
        reason: "Axiom book in progress — Juno autonomously writes/reviews chapters",
      };
    }
  }

  if (agiDone && !bookDone && !bookStarted) {
    if (state.autoQueuedToday >= effective.maxAutoQueueMissions) {
      return {
        action: "escalate_human",
        reason: "auto_queue_cap",
        detail: "Daily auto-queue cap — book mission bootstrap deferred to tomorrow",
      };
    }
    if (effective.allowedMissionIds.includes("juno-axiom-book-2026")) {
      return {
        action: "queue_mission",
        missionId: "juno-axiom-book-2026",
        bootstrap: "queue:axiom-book",
        reason:
          "AGI complete — Juno self-decides to start axiom book experiment (charter-only constraints)",
      };
    }
  }

  if (effective.requireLoopGateForScheduler && !gate.ok) {
    return {
      action: "stop",
      reason: `loop_gate: ${gate.reason}`,
    };
  }

  return {
    action: "stop",
    reason: bookDone
      ? "axiom book complete — await human next north-star"
      : "no_autonomous_work_remaining — await human north-star",
  };
}

export function recordAutonomyDecision(
  workbench: string,
  decision: AutonomyDecision,
): AutonomyState {
  const state = readAutonomyState(workbench);
  state.lastAction = decision.action;
  state.lastDecisionAt = new Date().toISOString();
  if ("missionId" in decision) state.lastMissionId = decision.missionId;
  if (
    decision.action === "run_local_loop" ||
    decision.action === "run_agi_loop" ||
    decision.action === "run_book_loop" ||
    decision.action === "queue_mission"
  ) {
    state.iterationsToday += 1;
  }
  if (decision.action === "queue_mission") {
    state.autoQueuedToday += 1;
  }
  writeAutonomyState(workbench, state);
  return state;
}
