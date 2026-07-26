import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
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

    releaseAutonomyLock(wb, "daily-juno");
    expect(acquireAutonomyLock(wb, "juno-daemon", 999_999)).toBe(true);
    releaseAutonomyLock(wb, "juno-daemon", 999_999);
  });

  it("fails closed for a fresh incomplete lock and recovers an old corrupt lock", () => {
    const wb = mkdtempSync(path.join(os.tmpdir(), "juno-lock-corrupt-"));
    const state = path.join(wb, "state");
    const lock = path.join(state, "autonomy.lock.json");
    mkdirSync(state, { recursive: true });
    writeFileSync(lock, "{", "utf8");

    expect(acquireAutonomyLock(wb, "daily-juno")).toBe(false);

    const old = new Date(Date.now() - 10_000);
    utimesSync(lock, old, old);
    expect(acquireAutonomyLock(wb, "daily-juno")).toBe(true);
    expect(readAutonomyLock(wb)?.holder).toBe("daily-juno");
    releaseAutonomyLock(wb, "daily-juno");
  });

  it("does not release another holder, blocks on a fresh guard, and recovers a stale guard", () => {
    const wb = mkdtempSync(path.join(os.tmpdir(), "juno-lock-owner-"));
    const state = path.join(wb, "state");
    mkdirSync(state, { recursive: true });
    expect(acquireAutonomyLock(wb, "daily-juno")).toBe(true);
    releaseAutonomyLock(wb, "juno-daemon");
    expect(readAutonomyLock(wb)?.holder).toBe("daily-juno");
    releaseAutonomyLock(wb, "daily-juno");

    const recoveryGuard = path.join(state, "autonomy.lock.recovery");
    writeFileSync(recoveryGuard, "residual", "utf8");
    expect(acquireAutonomyLock(wb, "juno-daemon")).toBe(false);

    const old = new Date(Date.now() - 60_000);
    utimesSync(recoveryGuard, old, old);
    expect(acquireAutonomyLock(wb, "juno-daemon")).toBe(true);
    releaseAutonomyLock(wb, "juno-daemon");
  });
});
