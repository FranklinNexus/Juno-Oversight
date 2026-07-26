import type { RunKind } from "./types.js";
import { hasUniqueCompleteStatus } from "./checkpoint-status.js";

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
  | { action: "hold"; reason: "review_pending" | "review_revise" | "verify_pending" }
  | { action: "block" }
  | { action: "revise"; mustFix: string[] };

function extractReviewSection(checkpointText: string): string | null {
  const match = checkpointText.match(/##\s*REVIEW_VERDICT[\s\S]*?(?=\n##\s|$)/i);
  return match?.[0] ?? null;
}

function extractMarkdownSection(checkpointText: string, heading: string): string | null {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingMatch = new RegExp(`^##\\s*${escapedHeading}\\s*$`, "im").exec(checkpointText);
  if (!headingMatch || headingMatch.index === undefined) return null;

  const bodyStart = headingMatch.index + headingMatch[0].length;
  const remainder = checkpointText.slice(bodyStart);
  const nextHeading = /^##\s+/m.exec(remainder);
  return remainder.slice(0, nextHeading?.index ?? remainder.length);
}

function hasNonEmptyChanges(checkpointText: string): boolean {
  const changes = extractMarkdownSection(checkpointText, "CHANGES");
  if (changes === null) return false;

  const meaningfulBody = changes
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !/^\s*STATUS:\s*COMPLETE\s*$/i.test(line))
    .filter((line) => !/^\s*(?:[-*+]\s*)?$/.test(line))
    .join("\n")
    .trim();
  return meaningfulBody.length > 0;
}

function hasExplicitVerifyFailure(report: string): boolean {
  const normalized = report
    .replace(/\berror(?:-|\s+)handling\b/gi, "")
    .replace(/\b(?:no|zero|0)\s+(?:errors?|failures?)\b/gi, "")
    .replace(
      /\b(?:errors?|failures?)(?:\s+(?:count|found))?\s*[:=]\s*(?:0|none|false)\b/gi,
      "",
    )
    .replace(/\bwithout\s+(?:errors?|failures?)\b/gi, "");

  if (/\b(?:FAIL|FAILED|FAILURE|ERR|ERROR|ERRORS|EXCEPTION)\b/i.test(normalized)) return true;
  if (/\bverdict\s*:\s*BLOCK\b/i.test(normalized)) return true;
  if (/\bnon[-\s]?zero\b/i.test(normalized)) return true;
  if (/\bnot\s+pass(?:ed)?\b|\bpass(?:ed)?\s*[:=]\s*false\b/i.test(normalized)) return true;

  const exitCodePattern =
    /\b(?:(?:exit(?:ed)?|return(?:ed)?)(?:\s+with)?[\s_-]*(?:code|status)|exit|return|process\s+status)\s*[:=]?\s*(-?\d+)\b/gi;
  for (const match of normalized.matchAll(exitCodePattern)) {
    if (Number(match[1]) !== 0) return true;
  }
  return false;
}

function hasExplicitVerifyPass(report: string): boolean {
  return /\bPASS(?:ED)?\b/i.test(report) && !/\bpass(?:ed)?\s*[:=]\s*false\b/i.test(report);
}

export function hasCompleteImplementEvidence(checkpointText: string): boolean {
  return hasUniqueCompleteStatus(checkpointText) && hasNonEmptyChanges(checkpointText);
}

export function hasPassingVerifyEvidence(checkpointText: string): boolean {
  const report = extractMarkdownSection(checkpointText, "VERIFY_REPORT");
  if (report === null || hasExplicitVerifyFailure(report)) return false;
  return hasExplicitVerifyPass(report);
}

function parseListField(section: string, field: string): string[] | null {
  const match = section.match(new RegExp(`${field}:\\s*(\\[[^\\]]*\\])`, "i"));
  if (!match) return null;
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
  const scopeViolations = parseListField(section, "scope_violations");
  const mustFixNextSlot = parseListField(section, "must_fix_next_slot");
  const reviewerNotes = notesMatch?.[1]?.trim();
  if (!driftMatch || scopeViolations === null || mustFixNextSlot === null || !reviewerNotes) {
    return null;
  }
  const verdict = verdictMatch[1].toUpperCase() as ReviewVerdictValue;
  if (verdict === "REVISE" && mustFixNextSlot.length === 0) return null;

  return {
    verdict,
    drift: driftMatch[1].toLowerCase(),
    scopeViolations,
    mustFixNextSlot,
    reviewerNotes,
  };
}

export function isReviewBlocked(checkpointText: string): boolean {
  const parsed = parseReviewVerdict(checkpointText);
  if (!parsed) return false;
  return (
    parsed.verdict === "BLOCK" ||
    (parsed.verdict === "PASS" &&
      (parsed.drift === "major" || parsed.scopeViolations.length > 0))
  );
}

export function isReviewPass(checkpointText: string): boolean {
  const parsed = parseReviewVerdict(checkpointText);
  return (
    parsed?.verdict === "PASS" &&
    parsed.drift !== "major" &&
    parsed.scopeViolations.length === 0
  );
}

/** Decide whether scheduler should dequeue queue head after a completed run. */
export function resolveQueueAdvance(
  runKind: RunKind,
  checkpointText: string,
): QueueAdvanceAction {
  if (runKind === "verify") {
    const reviewSection = extractReviewSection(checkpointText);
    if (reviewSection && !parseReviewVerdict(checkpointText)) {
      return { action: "block" };
    }
    if (isReviewBlocked(checkpointText)) {
      return { action: "block" };
    }
    const report = extractMarkdownSection(checkpointText, "VERIFY_REPORT");
    if (report === null) {
      return { action: "hold", reason: "verify_pending" };
    }
    if (hasExplicitVerifyFailure(report)) {
      return { action: "block" };
    }
    return hasExplicitVerifyPass(report)
      ? { action: "dequeue" }
      : { action: "hold", reason: "verify_pending" };
  }

  if (runKind === "implement") {
    if (hasCompleteImplementEvidence(checkpointText)) {
      return { action: "dequeue" };
    }
    return { action: "hold", reason: "review_pending" };
  }

  if (runKind === "debate" || runKind === "review" || runKind === "vote") {
    const parsed = parseReviewVerdict(checkpointText);
    if (!parsed) {
      return { action: "hold", reason: "review_pending" };
    }
    switch (parsed.verdict) {
      case "PASS":
        return isReviewPass(checkpointText) ? { action: "dequeue" } : { action: "block" };
      case "BLOCK":
        return { action: "block" };
      case "REVISE":
        return { action: "revise", mustFix: parsed.mustFixNextSlot };
      default:
        return { action: "hold", reason: "review_pending" };
    }
  }

  return { action: "hold", reason: "review_pending" };
}

/** Mission queue should alternate implement/review pairs after the first slot. */
export function validateReviewAlternation(items: Array<{ run_kind?: RunKind; kind?: string }>): boolean {
  if (items.length < 2) return true;

  const kinds = items.map((item) => item.run_kind ?? inferKindFromItem(item));
  for (let i = 1; i < kinds.length; i += 1) {
    const prev = kinds[i - 1];
    const curr = kinds[i];
    if (prev === "implement" && curr !== "review" && curr !== "debate") return false;
    if (prev === "debate" && curr !== "review") return false;
    if (prev === "review" && curr !== "implement" && curr !== "verify") return false;
    if (prev === "verify" && curr !== "review") return false;
  }
  return true;
}

function inferKindFromItem(item: { run_kind?: RunKind; kind?: string }): RunKind {
  if (item.run_kind) return item.run_kind;
  if (item.kind === "review") return "review";
  if (item.kind === "debate") return "debate";
  if (item.kind === "verify") return "verify";
  return "implement";
}
