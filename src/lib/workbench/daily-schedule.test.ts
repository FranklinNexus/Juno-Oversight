import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_DAILY_SCHEDULE,
  loadDailySchedule,
} from "../../../orchestrator/src/daily-schedule.js";

function workbench(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "juno-daily-schedule-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  return root;
}

describe("daily schedule", () => {
  it("uses defaults only when the config file is absent", () => {
    expect(loadDailySchedule(workbench())).toEqual(DEFAULT_DAILY_SCHEDULE);
  });

  it("fails closed on malformed or unsafe control fields", () => {
    const malformed = workbench();
    writeFileSync(path.join(malformed, "config", "daily-schedule.json"), "{broken", "utf8");
    expect(() => loadDailySchedule(malformed)).toThrow(/refusing scheduled autonomy/i);

    const hotLoop = workbench();
    writeFileSync(
      path.join(hotLoop, "config", "daily-schedule.json"),
      JSON.stringify({ tickIntervalMs: 0 }),
      "utf8",
    );
    expect(() => loadDailySchedule(hotLoop)).toThrow(/invalid control fields/i);

    const badZone = workbench();
    writeFileSync(
      path.join(badZone, "config", "daily-schedule.json"),
      JSON.stringify({ autonomyTimezone: "Not/A-Timezone" }),
      "utf8",
    );
    expect(() => loadDailySchedule(badZone)).toThrow(/invalid autonomyTimezone/i);
  });
});
