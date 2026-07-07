import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunKind } from "./types.js";

function readRunCheckpoint(workbench: string, runId: string): string {
  const cp = path.join(workbench, "runs", runId, "checkpoint.md");
  try {
    return readFileSync(cp, "utf8");
  } catch {
    return "";
  }
}

function isRunCheckpointStubText(checkpointText: string): boolean {
  return !/##\s*VERIFY_REPORT|REVIEW_VERDICT|STATUS:\s*COMPLETE/i.test(checkpointText);
}

interface FinishedEvent {
  type?: string;
  status?: string;
  result?: string;
}

/** Last successful `finished` event from runs/<id>/events.jsonl. */
export function readLastFinishedEvent(runDir: string): FinishedEvent | null {
  const eventsPath = path.join(runDir, "events.jsonl");
  if (!existsSync(eventsPath)) return null;

  const lines = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!) as FinishedEvent;
      if (event.type === "finished" && event.status === "finished" && event.result?.trim()) {
        return event;
      }
    } catch {
      // skip malformed line
    }
  }
  return null;
}

function extractSection(text: string, heading: string): string | null {
  const re = new RegExp(`^##\\s*${heading}\\s*$([\\s\\S]*?)(?=^##\\s|$)`, "im");
  const m = text.match(re);
  return m?.[1]?.trim() ?? null;
}

function looksImplementComplete(result: string): boolean {
  if (/STATUS:\s*COMPLETE/i.test(result)) return true;
  if (!/已完成/i.test(result)) return false;
  return /✅|successCriteria|验收/.test(result);
}

function looksVerifyComplete(result: string): boolean {
  if (/##\s*VERIFY_REPORT/i.test(result)) return true;
  return /VERIFY_REPORT[\s\S]*PASS/i.test(result);
}

function looksReviewComplete(result: string): boolean {
  return /REVIEW_VERDICT:\s*PASS/i.test(result) || /verdict:\s*PASS/i.test(result);
}

function runKindLooksComplete(runKind: RunKind, result: string): boolean {
  if (runKind === "verify") return looksVerifyComplete(result);
  if (runKind === "review" || runKind === "debate" || runKind === "vote") {
    return looksReviewComplete(result);
  }
  return looksImplementComplete(result);
}

function buildCheckpointFromResult(runId: string, runKind: RunKind, result: string): string {
  const changes =
    extractSection(result, "改动摘要") ??
    extractSection(result, "CHANGES") ??
    extractSection(result, "本 slot 改动") ??
    extractSection(result, "现状");

  const meta = extractSection(result, "METACOGNITION");

  const lines = [`# Checkpoint — ${runId}`, "", "STATUS: COMPLETE", ""];

  if (changes) {
    lines.push("## CHANGES", "", changes, "");
  } else {
    lines.push("## CHANGES", "", result.trim().slice(0, 4000), "");
  }

  if (meta) {
    lines.push("## METACOGNITION", "", meta, "");
  } else if (runKind === "implement") {
    lines.push(
      "## METACOGNITION",
      "",
      "- understood: yes",
      "- reviewed: yes",
      "- review_depth: adequate",
      "- new_angles: [\"synced from finished event — agent claimed checkpoint but file was stub\"]",
      "- should_revisit: false",
      "- confidence: 0.85",
      "- notes: auto-synced by orchestrator checkpoint-sync",
      "",
    );
  }

  if (!/STATUS:\s*COMPLETE/i.test(lines.join("\n"))) {
    lines.push("STATUS: COMPLETE", "");
  }

  return `${lines.join("\n").trim()}\n`;
}

/**
 * When Live Agent finished successfully but left runs/<id>/checkpoint.md as materialize stub,
 * synthesize checkpoint from the last `finished` event in events.jsonl.
 */
export function syncCheckpointFromEvents(
  workbench: string,
  runId: string,
  runKind: RunKind,
): boolean {
  const runDir = path.join(workbench, "runs", runId);
  const cpPath = path.join(runDir, "checkpoint.md");
  const existing = readRunCheckpoint(workbench, runId);
  if (!isRunCheckpointStubText(existing)) return false;

  const finished = readLastFinishedEvent(runDir);
  if (!finished?.result) return false;
  if (!runKindLooksComplete(runKind, finished.result)) return false;

  writeFileSync(cpPath, buildCheckpointFromResult(runId, runKind, finished.result), "utf8");
  return true;
}
