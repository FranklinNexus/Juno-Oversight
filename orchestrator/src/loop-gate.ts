import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface LoopGateResult {
  ok: boolean;
  reason: string;
}

export interface LoopGateStamp {
  passedAt: string;
  missionId: string;
  runner: string;
}

const SMOKE_MISSION = "juno-smoke-loop-2026";
const META_MISSION = "juno-loop-meta-2026";
const STAMP_MAX_AGE_MS = 24 * 60 * 60_000;

function missionCheckpointComplete(workbench: string, missionId: string): boolean {
  const cp = path.join(workbench, "missions", missionId, "checkpoint.md");
  if (!existsSync(cp)) return false;
  const text = readFileSync(cp, "utf8");
  return /STATUS:\s*COMPLETE/i.test(text);
}

export function readLoopGateStamp(workbench: string): LoopGateStamp | null {
  const stampPath = path.join(workbench, "state", "loop-gate.json");
  if (!existsSync(stampPath)) return null;
  try {
    return JSON.parse(readFileSync(stampPath, "utf8")) as LoopGateStamp;
  } catch {
    return null;
  }
}

export function writeLoopGateStamp(
  workbench: string,
  missionId: string,
  runner = "run-minimal-loop.mjs",
): void {
  const stampPath = path.join(workbench, "state", "loop-gate.json");
  const stamp: LoopGateStamp = {
    passedAt: new Date().toISOString(),
    missionId,
    runner,
  };
  writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
}

function stampFresh(workbench: string): boolean {
  const stamp = readLoopGateStamp(workbench);
  if (!stamp?.passedAt) return false;
  const age = Date.now() - Date.parse(stamp.passedAt);
  return Number.isFinite(age) && age >= 0 && age <= STAMP_MAX_AGE_MS;
}

function readRequireLoopGateFromConfig(workbench: string): boolean {
  const cfg = path.join(workbench, "config.yaml");
  if (!existsSync(cfg)) return false;
  const text = readFileSync(cfg, "utf8");
  return /require_loop_gate:\s*true/i.test(text);
}

export function isLoopGateRequired(workbench: string): boolean {
  if (process.env.JUNO_SKIP_LOOP_GATE === "1") return false;
  if (process.env.JUNO_REQUIRE_LOOP_GATE === "1") return true;
  if (process.env.JUNO_REQUIRE_LOOP_GATE === "0") return false;
  return readRequireLoopGateFromConfig(workbench);
}

/** Returns ok=false when gate is required but smoke+meta not satisfied. */
export function evaluateLoopGate(workbench: string): LoopGateResult {
  if (!isLoopGateRequired(workbench)) {
    return { ok: true, reason: "loop_gate_optional" };
  }

  const smoke = missionCheckpointComplete(workbench, SMOKE_MISSION);
  const meta = missionCheckpointComplete(workbench, META_MISSION);
  if (smoke && meta) {
    return { ok: true, reason: "missions_complete" };
  }

  if (stampFresh(workbench)) {
    return { ok: true, reason: "loop_gate_stamp_fresh" };
  }

  const missing = [
    !smoke ? SMOKE_MISSION : null,
    !meta ? META_MISSION : null,
  ]
    .filter(Boolean)
    .join(", ");
  return {
    ok: false,
    reason: `loop_gate_blocked: run pnpm loop:smoke (missing: ${missing})`,
  };
}

export { SMOKE_MISSION, META_MISSION };
