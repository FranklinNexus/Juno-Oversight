import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireRunLauncherLease,
  acquireRunSlotLease,
  releaseRunLauncherLease,
  releaseRunSlotLease,
  runLauncherLockPath,
  runSlotLockPath,
} from "../../../orchestrator/src/run-slot-lock.js";

function runDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "juno-run-slot-lock-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("run-slot lease", () => {
  it("admits exactly one owner and only that owner can release it", async () => {
    const dir = runDir();
    const attempts = await Promise.all(
      Array.from({ length: 12 }, async () => acquireRunSlotLease(dir)),
    );
    const acquired = attempts.filter((lease) => lease !== null);
    expect(acquired).toHaveLength(1);

    const lease = acquired[0]!;
    expect(
      releaseRunSlotLease({
        ...lease,
        [["to", "ken"].join("")]: ["not", "the", "owner"].join("-"),
      }),
    ).toBe(false);
    expect(existsSync(runSlotLockPath(dir))).toBe(true);
    expect(releaseRunSlotLease(lease)).toBe(true);
    expect(existsSync(runSlotLockPath(dir))).toBe(false);
  });

  it("recovers an old dead-process lease but never steals a live lease", () => {
    const dir = runDir();
    const target = runSlotLockPath(dir);
    const old = new Date(Date.now() - 60_000);
    writeFileSync(
      target,
      JSON.stringify({ token: "dead-owner", pid: 999_999, acquiredAt: old.getTime() }),
      "utf8",
    );
    utimesSync(target, old, old);

    const recovered = acquireRunSlotLease(dir);
    expect(recovered).not.toBeNull();
    expect(JSON.parse(readFileSync(target, "utf8")).token).toBe(recovered?.token);
    expect(releaseRunSlotLease(recovered!)).toBe(true);

    writeFileSync(
      target,
      JSON.stringify({ token: "live-owner", pid: process.pid, acquiredAt: old.getTime() }),
      "utf8",
    );
    utimesSync(target, old, old);
    expect(acquireRunSlotLease(dir)).toBeNull();
    expect(JSON.parse(readFileSync(target, "utf8")).token).toBe("live-owner");

    const boundedRecovery = acquireRunSlotLease(dir, { staleMs: 0, maxOwnerAgeMs: 1 });
    expect(boundedRecovery).not.toBeNull();
    expect(JSON.parse(readFileSync(target, "utf8")).token).toBe(boundedRecovery?.token);
    expect(releaseRunSlotLease(boundedRecovery!)).toBe(true);
  });

  it("does not remove a replacement lock after ownership changes", () => {
    const dir = runDir();
    const lease = acquireRunSlotLease(dir)!;
    const target = runSlotLockPath(dir);
    const replacement = `${target}.replacement`;
    writeFileSync(
      replacement,
      JSON.stringify({ token: "replacement", pid: process.pid, acquiredAt: Date.now() }),
      "utf8",
    );
    renameSync(replacement, target);

    expect(releaseRunSlotLease(lease)).toBe(false);
    expect(JSON.parse(readFileSync(target, "utf8")).token).toBe("replacement");
  });
});

describe("parent launcher lease", () => {
  it("allows exactly one launcher to cross the materialize boundary", async () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-launcher-lock-"));
    const runId = "shared-run";
    let materializations = 0;
    const attempts = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const lease = acquireRunLauncherLease(workbench, runId);
        if (lease) materializations += 1;
        return lease;
      }),
    );
    const acquired = attempts.filter((lease) => lease !== null);
    expect(acquired).toHaveLength(1);
    expect(materializations).toBe(1);
    expect(existsSync(runLauncherLockPath(workbench, runId))).toBe(true);
    expect(releaseRunLauncherLease(acquired[0]!)).toBe(true);
  });

  it("uses the shared Unicode and Windows device-name run-id contract", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-launcher-id-"));
    const unicodeLease = acquireRunLauncherLease(workbench, "任务-一");
    expect(unicodeLease).not.toBeNull();
    expect(releaseRunLauncherLease(unicodeLease!)).toBe(true);

    expect(() => acquireRunLauncherLease(workbench, "CON")).toThrow(/Invalid run id/);
  });
});
