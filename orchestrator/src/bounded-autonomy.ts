import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BOOK_EXPERIMENT_LIMITS,
  DEFAULT_AUTONOMY_LIMITS,
  type AutonomyDecision,
  type AutonomyLimits,
  type AutonomyState,
} from "./autonomy-types.js";
import { planNextMission, writePlannerSnapshot } from "./mission-planner.js";

export type { AutonomyDecision, AutonomyLimits, AutonomyState } from "./autonomy-types.js";
export { DEFAULT_AUTONOMY_LIMITS, BOOK_EXPERIMENT_LIMITS } from "./autonomy-types.js";

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

function missionStarted(workbench: string, missionId: string): boolean {
  return existsSync(path.join(workbench, "missions", missionId, "progress.md"));
}

function limitsForWorkbench(workbench: string, base: AutonomyLimits): AutonomyLimits {
  if (
    missionStarted(workbench, "juno-axiom-book-2026") &&
    !existsSync(path.join(workbench, "missions", "juno-axiom-book-2026", "checkpoint.md"))
  ) {
    return BOOK_EXPERIMENT_LIMITS;
  }
  const cp = path.join(workbench, "missions", "juno-axiom-book-2026", "checkpoint.md");
  if (missionStarted(workbench, "juno-axiom-book-2026") && existsSync(cp)) {
    const text = readFileSync(cp, "utf8");
    if (!/STATUS:\s*COMPLETE/i.test(text)) return BOOK_EXPERIMENT_LIMITS;
  }
  return base;
}

/**
 * Bounded self-decision: charter + mission registry → next action without human-assigned mission.
 */
export function decideNextAction(
  workbench: string,
  limits: AutonomyLimits = DEFAULT_AUTONOMY_LIMITS,
): AutonomyDecision {
  const effective = limitsForWorkbench(workbench, limits);
  const state = readAutonomyState(workbench);
  const decision = planNextMission({ workbench, state, limits: effective });
  writePlannerSnapshot(workbench, decision);
  return decision;
}

export function recordAutonomyDecision(
  workbench: string,
  decision: AutonomyDecision,
): AutonomyState {
  const state = readAutonomyState(workbench);
  state.lastAction = decision.action;
  state.lastDecisionAt = new Date().toISOString();
  if ("missionId" in decision) state.lastMissionId = decision.missionId;

  const countsAsIteration =
    decision.action === "run_local_loop" ||
    decision.action === "run_agi_loop" ||
    decision.action === "run_book_loop" ||
    decision.action === "run_book_quality_loop" ||
    decision.action === "run_generic_loop" ||
    decision.action === "run_self_optimize" ||
    decision.action === "queue_mission";

  if (countsAsIteration) state.iterationsToday += 1;
  if (decision.action === "queue_mission") state.autoQueuedToday += 1;

  writeAutonomyState(workbench, state);
  return state;
}
