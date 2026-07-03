/**
 * Hardening mission queue repair — sync now.yaml with progress.md queued phases.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseNowYaml, saveNowQueue } from "./queue-io.js";
import type { QueueItem } from "./types.js";

export const HARDENING_MISSION_ID = "juno-overseer-hardening-2026";

export interface HardeningPhaseSpec {
  phaseId: string;
  kind: string;
  criteria: string;
}

export const HARDENING_PHASE_SPECS: HardeningPhaseSpec[] = [
  { phaseId: "h07-promote-preview", kind: "implement", criteria: "Promote diff preview UI/log" },
  { phaseId: "h08-review-promote", kind: "review", criteria: "REVIEW_VERDICT on promote preview" },
  { phaseId: "h09-verify-all", kind: "verify", criteria: "test+lint+cargo VERIFY_REPORT" },
  { phaseId: "h10-drift-audit", kind: "review", criteria: "drift audit REVIEW_VERDICT" },
  { phaseId: "h11-final", kind: "review", criteria: "final mission REVIEW_VERDICT" },
];

function progressPath(workbench: string): string {
  return path.join(workbench, "missions", HARDENING_MISSION_ID, "progress.md");
}

/** Queued hardening phases in progress table order (h07–h11 only). */
export function parseHardeningProgressQueued(workbench: string): string[] {
  const allowed = new Set(HARDENING_PHASE_SPECS.map((s) => s.phaseId));
  const p = progressPath(workbench);
  if (!existsSync(p)) return [];
  const queued: string[] = [];
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || trimmed.startsWith("|--") || trimmed.startsWith("| Phase")) {
      continue;
    }
    const cols = trimmed
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cols.length < 3) continue;
    const phaseId = cols[0];
    if (allowed.has(phaseId) && /^queued$/i.test(cols[2])) {
      queued.push(phaseId);
    }
  }
  return queued;
}

export function buildHardeningQueueItem(spec: HardeningPhaseSpec): QueueItem {
  const prompt =
    spec.kind === "implement"
      ? "executor_implement"
      : spec.kind === "verify"
        ? "executor_verify"
        : "executor_review";
  return {
    id: `juno-${spec.phaseId}`,
    horizon: "mission",
    kind: spec.kind,
    run_kind: spec.kind as QueueItem["run_kind"],
    repo_target: "juno-overseer",
    mission_id: HARDENING_MISSION_ID,
    phase_id: spec.phaseId,
    prompt,
    provider: "cursor_composer",
    max_minutes: 25,
    success_criteria: spec.criteria,
  };
}

function hardeningPhaseOrder(phaseId: string): number {
  const idx = HARDENING_PHASE_SPECS.findIndex((s) => s.phaseId === phaseId);
  return idx >= 0 ? idx : 999;
}

function sameHardeningHead(now: QueueItem[], expected: string[]): boolean {
  const hardening = now.filter((i) => i.mission_id === HARDENING_MISSION_ID);
  if (hardening.length !== expected.length) return false;
  return hardening.every((item, i) => item.phase_id === expected[i]);
}

export interface HardeningQueueRepairResult {
  changed: boolean;
  reason: string;
  addedPhases: string[];
  now: QueueItem[];
  backlog: QueueItem[];
}

/**
 * Rebuild hardening section of now.yaml from progress.md queued phases (h07–h11).
 * Fixes partial queues (e.g. h09 missing while h10/h11 remain).
 */
export function repairHardeningQueue(workbench: string): HardeningQueueRepairResult {
  const { now, backlog } = parseNowYaml(workbench);
  const queuedPhaseIds = parseHardeningProgressQueued(workbench);

  if (queuedPhaseIds.length === 0) {
    return {
      changed: false,
      reason: "no queued hardening phases in progress.md",
      addedPhases: [],
      now,
      backlog,
    };
  }

  if (sameHardeningHead(now, queuedPhaseIds)) {
    return {
      changed: false,
      reason: "hardening queue matches progress",
      addedPhases: [],
      now,
      backlog,
    };
  }

  const existingIds = new Set(
    now.filter((i) => i.mission_id === HARDENING_MISSION_ID).map((i) => i.phase_id),
  );
  const addedPhases = queuedPhaseIds.filter(
    (id) => !existingIds.has(id) && HARDENING_PHASE_SPECS.some((s) => s.phaseId === id),
  );

  const hardeningItems = queuedPhaseIds
    .map((phaseId) => HARDENING_PHASE_SPECS.find((s) => s.phaseId === phaseId))
    .filter((s): s is HardeningPhaseSpec => Boolean(s))
    .sort((a, b) => hardeningPhaseOrder(a.phaseId) - hardeningPhaseOrder(b.phaseId))
    .map(buildHardeningQueueItem);

  const otherNow = now.filter((i) => i.mission_id !== HARDENING_MISSION_ID);
  const nextNow = [...hardeningItems, ...otherNow];
  saveNowQueue(workbench, nextNow, backlog);

  return {
    changed: true,
    reason:
      addedPhases.length > 0
        ? `inserted missing phases: ${addedPhases.join(", ")}`
        : "reordered hardening queue to match progress",
    addedPhases,
    now: nextNow,
    backlog,
  };
}

/** Legacy bootstrap when progress has queued phases but now is empty. */
export function bootstrapHardeningQueueFromSpecs(workbench: string): HardeningQueueRepairResult {
  const repair = repairHardeningQueue(workbench);
  if (repair.changed) return repair;

  const { now, backlog } = parseNowYaml(workbench);
  const hasHardening = now.some((i) => i.mission_id === HARDENING_MISSION_ID);
  if (hasHardening) {
    return { changed: false, reason: "hardening queue already present", addedPhases: [], now, backlog };
  }

  const items = HARDENING_PHASE_SPECS.map(buildHardeningQueueItem);
  saveNowQueue(workbench, items, backlog);
  return {
    changed: true,
    reason: "bootstrapped full h07–h11 queue",
    addedPhases: HARDENING_PHASE_SPECS.map((s) => s.phaseId),
    now: items,
    backlog,
  };
}
