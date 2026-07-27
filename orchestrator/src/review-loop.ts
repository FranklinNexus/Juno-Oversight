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
  | { action: "hold"; reason: "review_pending" | "review_revise" | "verify_pending" }
  | { action: "block" }
  | { action: "revise"; mustFix: string[] };

function extractReviewSection(checkpointText: string): string | null {
  const match = checkpointText.match(/##\s*REVIEW_VERDICT[\s\S]*?(?=\n##\s|$)/i);
  return match?.[0] ?? null;
}

function parseListField(section: string, field: string): string[] {
  const lines = section.split(/\r?\n/);
  const fieldPattern = new RegExp(`^\\s*-?\\s*${field}:\\s*(.*)$`, "i");
  const fieldIndex = lines.findIndex((line) => fieldPattern.test(line));
  if (fieldIndex < 0) return [];
  const inline = lines[fieldIndex].match(fieldPattern)?.[1]?.trim() ?? "";

  const parseValue = (value: string): string[] => {
    const cleaned = value.trim();
    if (!cleaned) return [];
    if (!cleaned.startsWith("[")) {
      return [cleaned.replace(/^["']|["']$/g, "")].filter(Boolean);
    }
    try {
      const parsed = JSON.parse(cleaned.replace(/'/g, '"')) as unknown;
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      const inner = cleaned.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
  };

  if (inline) return parseValue(inline);

  const values: string[] = [];
  for (const line of lines.slice(fieldIndex + 1)) {
    if (/^\s*-\s*[a-z_][a-z0-9_]*:/i.test(line)) break;
    const bullet = line.match(/^\s*-\s*(.+)$/);
    if (bullet) values.push(...parseValue(bullet[1]));
  }
  return values;
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
    if (!/##\s*VERIFY_REPORT/i.test(checkpointText)) {
      return { action: "hold", reason: "verify_pending" };
    }
    if (isReviewBlocked(checkpointText)) {
      return { action: "block" };
    }
    if (/##\s*VERIFY_REPORT[\s\S]*?\*\*FAIL\*\*|verdict:\s*BLOCK/i.test(checkpointText)) {
      return { action: "block" };
    }
    return { action: "dequeue" };
  }

  if (runKind === "implement") {
    if (/STATUS:\s*COMPLETE/i.test(checkpointText)) {
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
        return { action: "dequeue" };
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
