import { describe, expect, it } from "vitest";
import { todayAutonomyDate } from "../../../orchestrator/src/autonomy-day.js";

describe("autonomy-day", () => {
  it("formats date in configured timezone", () => {
    const d = todayAutonomyDate("/tmp/unused", "Asia/Shanghai");
    expect(/^\d{4}-\d{2}-\d{2}$/.test(d)).toBe(true);
  });
});
