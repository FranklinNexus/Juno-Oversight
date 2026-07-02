import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, utimesSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  acquireAutonomyLock,
  readAutonomyLock,
  releaseAutonomyLock,
} from "../../../orchestrator/src/autonomy-lock.js";

describe("autonomy-lock", () => {
  it("blocks second holder while lock alive", () => {
    const wb = mkdtempSync(path.join(os.tmpdir(), "juno-lock-"));
    mkdirSync(path.join(wb, "state"), { recursive: true });

    expect(acquireAutonomyLock(wb, "daily-juno")).toBe(true);
    expect(acquireAutonomyLock(wb, "juno-daemon", 999_999)).toBe(false);
    expect(readAutonomyLock(wb)?.holder).toBe("daily-juno");

    releaseAutonomyLock(wb);
    expect(acquireAutonomyLock(wb, "juno-daemon", 999_999)).toBe(true);
    releaseAutonomyLock(wb, 999_999);
  });
});
