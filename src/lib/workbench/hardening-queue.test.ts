import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseHardeningProgressQueued,
  repairHardeningQueue,
} from "../../../orchestrator/src/hardening-queue.js";

describe("hardening-queue", () => {
  it("parses queued phases from progress table", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-hq-"));
    mkdirSync(path.join(dir, "missions", "juno-overseer-hardening-2026"), { recursive: true });
    writeFileSync(
      path.join(dir, "missions", "juno-overseer-hardening-2026", "progress.md"),
      `# Progress\n\n| Phase | Kind | Status |\n| h08-review-promote | review | done |\n| h09-verify-all | verify | queued |\n| h10-drift-audit | review | queued |\n`,
      "utf8",
    );
    expect(parseHardeningProgressQueued(dir)).toEqual(["h09-verify-all", "h10-drift-audit"]);
  });

  it("repairs partial queue when h09 missing from now.yaml", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-hq-repair-"));
    mkdirSync(path.join(dir, "missions", "juno-overseer-hardening-2026"), { recursive: true });
    mkdirSync(path.join(dir, "queue"), { recursive: true });
    writeFileSync(
      path.join(dir, "missions", "juno-overseer-hardening-2026", "progress.md"),
      `# Progress\n\n| Phase | Kind | Status |\n| h09-verify-all | verify | queued |\n| h10-drift-audit | review | queued |\n| h11-final | review | queued |\n`,
      "utf8",
    );
    writeFileSync(
      path.join(dir, "queue", "now.yaml"),
      `updated: 2026-07-03T00:00:00.000Z
now:
  - id: juno-h10-drift-audit
    horizon: mission
    kind: review
    mission_id: juno-overseer-hardening-2026
    phase_id: h10-drift-audit
backlog: []
`,
      "utf8",
    );

    const result = repairHardeningQueue(dir);
    expect(result.changed).toBe(true);
    expect(result.addedPhases).toContain("h09-verify-all");

    const yaml = readFileSync(path.join(dir, "queue", "now.yaml"), "utf8");
    expect(yaml.indexOf("h09-verify-all")).toBeLessThan(yaml.indexOf("h10-drift-audit"));
    expect(yaml).toMatch(/h11-final/);
  });

  it("skips repair when hardening mission checkpoint is COMPLETE", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-hq-done-"));
    mkdirSync(path.join(dir, "missions", "juno-overseer-hardening-2026"), { recursive: true });
    mkdirSync(path.join(dir, "queue"), { recursive: true });
    writeFileSync(
      path.join(dir, "missions", "juno-overseer-hardening-2026", "checkpoint.md"),
      "# Checkpoint\n\nSTATUS: COMPLETE\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "missions", "juno-overseer-hardening-2026", "progress.md"),
      `# Progress\n\n| Phase | Kind | Status |\n| h09-verify-all | verify | queued |\n`,
      "utf8",
    );
    writeFileSync(
      path.join(dir, "queue", "now.yaml"),
      `updated: 2026-07-03T00:00:00.000Z
now:
  - id: juno-c02-execute
    mission_id: juno-workbench-cleanup-2026
    phase_id: c02-execute
backlog: []
`,
      "utf8",
    );

    const result = repairHardeningQueue(dir);
    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/complete/i);
    const yaml = readFileSync(path.join(dir, "queue", "now.yaml"), "utf8");
    expect(yaml).toMatch(/juno-c02-execute/);
    expect(yaml).not.toMatch(/h09-verify-all/);
  });
});
