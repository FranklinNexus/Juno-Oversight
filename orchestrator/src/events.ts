import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunEvent } from "./types.js";
import { nowIso } from "./env.js";

export function appendEvent(eventsPath: string, event: RunEvent): void {
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

export function touchHeartbeat(runDir: string): void {
  writeFileSync(path.join(runDir, "heartbeat.json"), JSON.stringify({ ts: nowIso() }), "utf8");
}
