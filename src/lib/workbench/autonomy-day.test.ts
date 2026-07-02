import { describe, expect, it } from "vitest";
import { msUntilNextAutonomyDay, todayAutonomyDate } from "../../../orchestrator/src/autonomy-day.js";

describe("autonomy-day", () => {
  it("formats date in configured timezone", () => {
    const d = todayAutonomyDate("/tmp/unused", "Asia/Shanghai");
    expect(/^\d{4}-\d{2}-\d{2}$/.test(d)).toBe(true);
  });

  it("msUntilNextAutonomyDay is positive and under 49h", () => {
    const ms = msUntilNextAutonomyDay("/tmp/unused");
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(49 * 3_600_000);
  });
});
