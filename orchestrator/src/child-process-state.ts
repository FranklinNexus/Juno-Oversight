import { readFileSync } from "node:fs";
import path from "node:path";
import type { RunState } from "./types.js";

export type ChildCompletionStatus = "done" | "failed";

export function readPersistedRunStatus(runDir: string): string | null {
  try {
    const state = JSON.parse(
      readFileSync(path.join(runDir, "run-state.json"), "utf8"),
    ) as RunState;
    return state.lastStatus?.trim().toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function classifyChildExit(
  runDir: string,
  exitCode: number | null,
): ChildCompletionStatus {
  if (exitCode === 0 || readPersistedRunStatus(runDir) === "done") {
    return "done";
  }
  return "failed";
}
