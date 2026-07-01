import type { RunKind } from "./types.js";

export type ReviewVerdictValue = "PASS" | "REVISE" | "BLOCK";

export interface ParsedReviewVerdict {
  verdict: ReviewVerdictValue;
  drift?: string;
  scopeViolations: string[];
  mustFixNextSlot: string[];
  reviewerNotes?: string;
}

export type QueueAdvanceAction =
  | { action: "dequeue" }
  | { action: "hold"; reason: "review_pending" | "review_revise" }
  | { action: "block" }
  | { action: "revise"; mustFix: string[] };

function extractReviewSection(checkpointText: string): string | null {
  const match = checkpointText.match(/##\s*REVIEW_VERDICT[\s\S]*?(?=\n##\s|$)/i);
  return match?.[0] ?? null;
}

function parseListField(section: string, field: string): string[] {
  const match = section.match(new RegExp(`${field}:\\s*(\\[[^\\]]*\\])`, "i"));
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1].replace(/'/g, '"')) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    const inner = match[1].slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
  }
}

export function parseReviewVerdict(checkpointText: string): ParsedReviewVerdict | null {
  const section = extractReviewSection(checkpointText);
  if (!section) return null;

  const verdictMatch = section.match(/verdict:\s*(PASS|REVISE|BLOCK)/i);
  if (!verdictMatch) return null;

  const driftMatch = section.match(/drift:\s*(none|minor|major)/i);
  const notesMatch = section.match(/reviewer_notes:\s*(.+)$/im);

  return {
    verdict: verdictMatch[1].toUpperCase() as ReviewVerdictValue,
    drift: driftMatch?.[1]?.toLowerCase(),
    scopeViolations: parseListField(section, "scope_violations"),
    mustFixNextSlot: parseListField(section, "must_fix_next_slot"),
    reviewerNotes: notesMatch?.[1]?.trim(),
  };
}

export function isReviewBlocked(checkpointText: string): boolean {
  const parsed = parseReviewVerdict(checkpointText);
  return parsed?.verdict === "BLOCK";
}

export function isReviewPass(checkpointText: string): boolean {
  const parsed = parseReviewVerdict(checkpointText);
  return parsed?.verdict === "PASS";
}

/** Decide whether scheduler should dequeue queue head after a completed run. */
export function resolveQueueAdvance(
  runKind: RunKind,
  checkpointText: string,
): QueueAdvanceAction {
  if (runKind === "verify") {
    if (isReviewBlocked(checkpointText)) {
      return { action: "block" };
    }
    if (/##\s*VERIFY_REPORT[\s\S]*?\*\*FAIL\*\*|verdict:\s*BLOCK/i.test(checkpointText)) {
      return { action: "block" };
    }
    return { action: "dequeue" };
  }

  if (runKind === "implement") {
    return { action: "dequeue" };
  }

  const parsed = parseReviewVerdict(checkpointText);
  if (!parsed) {
    return { action: "hold", reason: "review_pending" };
  }

  switch (parsed.verdict) {
    case "PASS":
      return { action: "dequeue" };
    case "BLOCK":
      return { action: "block" };
    case "REVISE":
      return { action: "revise", mustFix: parsed.mustFixNextSlot };
    default:
      return { action: "hold", reason: "review_pending" };
  }
}

/** Mission queue should alternate implement/review pairs after the first slot. */
export function validateReviewAlternation(items: Array<{ run_kind?: RunKind; kind?: string }>): boolean {
  if (items.length < 2) return true;

  const kinds = items.map((item) => item.run_kind ?? inferKindFromItem(item));
  for (let i = 1; i < kinds.length; i += 1) {
    const prev = kinds[i - 1];
    const curr = kinds[i];
    if (prev === "implement" && curr !== "review") return false;
    if (prev === "review" && curr !== "implement" && curr !== "verify") return false;
    if (prev === "verify" && curr !== "review") return false;
  }
  return true;
}

function inferKindFromItem(item: { run_kind?: RunKind; kind?: string }): RunKind {
  if (item.run_kind) return item.run_kind;
  if (item.kind === "review") return "review";
  if (item.kind === "verify") return "verify";
  return "implement";
}
