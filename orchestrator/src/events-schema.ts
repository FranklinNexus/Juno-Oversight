import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { RunKind } from "./types.js";

/** Machine-readable events.jsonl contract (literature P0). */
export type JunoEvent =
  | { ts: string; type: "status"; status: string; detail?: string }
  | { ts: string; type: "assistant"; text: string; partial?: boolean }
  | { ts: string; type: "finished"; status: string; result?: string }
  | { ts: string; type: "error"; message: string; retryable?: boolean }
  | { ts: string; type: "handoff"; from: RunKind | "queue"; to: RunKind; summary: string }
  | { ts: string; type: "verdict"; verdict: "PASS" | "REVISE" | "BLOCK"; notes?: string }
  | { ts: string; type: "tool_call"; tool: string; args?: string; ok?: boolean }
  | { ts: string; type: "reflexion"; trigger: string; lesson: string };

const EVENT_TYPES = new Set([
  "status",
  "assistant",
  "finished",
  "error",
  "handoff",
  "verdict",
  "tool_call",
  "reflexion",
]);

export function nowIso(): string {
  return new Date().toISOString();
}

export function isJunoEvent(value: unknown): value is JunoEvent {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (typeof o.ts !== "string" || typeof o.type !== "string") return false;
  if (!EVENT_TYPES.has(o.type)) return false;
  return true;
}

export function parseEventLine(line: string): JunoEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isJunoEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function appendEvent(eventsPath: string, event: JunoEvent): void {
  mkdirSync(path.dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

export function handoffEvent(
  from: RunKind | "queue",
  to: RunKind,
  summary: string,
): JunoEvent {
  return { ts: nowIso(), type: "handoff", from, to, summary };
}

export function verdictEvent(
  verdict: "PASS" | "REVISE" | "BLOCK",
  notes?: string,
): JunoEvent {
  return { ts: nowIso(), type: "verdict", verdict, notes };
}

export function reflexionEvent(trigger: string, lesson: string): JunoEvent {
  return { ts: nowIso(), type: "reflexion", trigger, lesson };
}
