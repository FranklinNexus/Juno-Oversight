import { resolveQueueAdvance, type QueueAdvanceAction } from "./review-loop.js";
import type { RunKind } from "./types.js";

export interface ObservedRunOutcome {
  observed: boolean;
  success: boolean;
  failure: boolean;
  revised: boolean;
  safetyBlocked: boolean;
  verifyPass: boolean;
  verifyFail: boolean;
  action: QueueAdvanceAction;
}

export function observeRunOutcome(
  runKind: RunKind,
  lastStatus: string,
  checkpoint: string,
  safetyReport = "",
): ObservedRunOutcome {
  const transportSuccess = /^(?:done|finished)$/i.test(lastStatus);
  const transportFailure = /^(?:failed|error|stall|cancelled|blocked)$/i.test(lastStatus);
  const observed = transportSuccess || transportFailure;
  const action = resolveQueueAdvance(runKind, checkpoint);
  const safetyBlocked = /-\s*ok:\s*FAIL/i.test(safetyReport);
  const revised = action.action === "revise";
  const success = observed && transportSuccess && action.action === "dequeue" && !safetyBlocked;
  const failure = observed && !success;
  return {
    observed,
    success,
    failure,
    revised,
    safetyBlocked,
    verifyPass: runKind === "verify" && success,
    verifyFail: runKind === "verify" && failure,
    action,
  };
}
