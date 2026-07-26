import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readNowQueueSnapshot } from "../../../orchestrator/src/queue-io.js";
import {
  evaluateWorkflowExperiment,
  inspectWorkflowSelectionMigration,
  migrateLegacyWorkflowSelection,
  promoteWorkflowExperiment,
  proposeWorkflowExperiment,
  queueWorkflowExperiment,
  workflowSelectionArchivePaths,
  workflowSelectionLockPath,
  workflowSelectionPath,
} from "../../../orchestrator/src/workflow-experiment.js";
import { writeTrustedExperimentRunEvidence } from "./workflow-experiment-evidence.test-helper.js";

function workbench(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "juno-selection-migration-"));
  for (const relative of ["missions/target", "prompts", "queue", "runs", "state"]) {
    mkdirSync(path.join(root, relative), { recursive: true });
  }
  for (const template of [
    "executor_book_review",
    "executor_book_write",
    "executor_implement",
    "executor_verify",
  ]) {
    writeFileSync(path.join(root, "prompts", `${template}.md`), `# ${template}\n`);
  }
  return root;
}

function legacySelection(workflowId = "variants/default-debate-v2"): string {
  return `${JSON.stringify({
    workflowId,
    score: 62,
    reasons: ["valid workflow JSON", "testsPass"],
    updatedAt: "2026-07-08T16:08:18.220Z",
  }, null, 2)}\n`;
}

function installTrustedSelection(root: string): void {
  const proposal = proposeWorkflowExperiment(root, {
    targetMissionId: "target",
    baselineWorkflowId: "axiom-book",
    candidateWorkflowId: "variants/axiom-book-lean-v2",
    requiredEpisodes: 2,
  });
  queueWorkflowExperiment(root, proposal.experimentId);
  const snapshot = readNowQueueSnapshot(root);
  const items = [...snapshot.now, ...snapshot.backlog].filter(
    (item) => item.experiment_id === proposal.experimentId,
  );
  for (const item of items) {
    writeTrustedExperimentRunEvidence(root, item);
  }
  expect(evaluateWorkflowExperiment(root, proposal.experimentId).status).toBe("accepted");
  promoteWorkflowExperiment(root, proposal.experimentId);
}

function holdSelectionLock(root: string): ChildProcessWithoutNullStreams {
  const script = [
    "const fs = require('node:fs');",
    "const lock = process.argv[1];",
    "const fd = fs.openSync(lock, 'wx');",
    "fs.writeFileSync(fd, JSON.stringify({ token: 'external-owner', pid: process.pid, acquiredAt: Date.now() }) + '\\n');",
    "fs.closeSync(fd);",
    "process.stdout.write('ready\\n');",
    "process.stdin.once('data', () => { fs.unlinkSync(lock); process.exit(0); });",
  ].join("\n");
  return spawn(process.execPath, ["-e", script, workflowSelectionLockPath(root)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("workflow selection migration inspection", () => {
  it("classifies strict legacy v0 without writing any control files", () => {
    const root = workbench();
    const raw = legacySelection();
    writeFileSync(workflowSelectionPath(root), raw);
    const before = readdirSync(path.join(root, "state"));
    const inspection = inspectWorkflowSelectionMigration(root);
    expect(inspection).toMatchObject({
      status: "legacy_v0",
      byteLength: Buffer.byteLength(raw),
      workflowId: "variants/default-debate-v2",
    });
    expect(inspection.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readdirSync(path.join(root, "state"))).toEqual(before);
  });

  it("never treats malformed or forged v1-like state as migratable legacy", () => {
    const root = workbench();
    writeFileSync(workflowSelectionPath(root), "{\n");
    expect(inspectWorkflowSelectionMigration(root).status).toBe("unsupported");

    writeFileSync(workflowSelectionPath(root), `${JSON.stringify({
      selectionVersion: 1,
      missionId: "target",
      workflowId: "axiom-book",
      active: true,
      experimentId: "forged",
      decisionReceiptSha256: "0".repeat(64),
      updatedAt: "2026-07-08T16:08:18.220Z",
    })}\n`);
    const inspection = inspectWorkflowSelectionMigration(root);
    expect(inspection.status).toBe("unsupported");
    expect(() => migrateLegacyWorkflowSelection(root, {
      expectedSha256: inspection.sha256!,
      reason: "Reject forged v1 during test",
    })).toThrow(/strict legacy v0/i);
  });

  it("rejects a verifiably trusted active selection", () => {
    const root = workbench();
    installTrustedSelection(root);
    const inspection = inspectWorkflowSelectionMigration(root);
    expect(inspection.status).toBe("trusted_v1");
    expect(() => migrateLegacyWorkflowSelection(root, {
      expectedSha256: inspection.sha256!,
      reason: "Trusted selections must use rollback",
    })).toThrow(/strict legacy v0/i);
    expect(existsSync(workflowSelectionPath(root))).toBe(true);
  });

  it("rejects hard-linked source state", () => {
    const root = workbench();
    writeFileSync(workflowSelectionPath(root), legacySelection());
    linkSync(workflowSelectionPath(root), path.join(root, "state", "foreign-link.json"));
    expect(() => inspectWorkflowSelectionMigration(root)).toThrow(/exclusive regular file/i);
  });

  it("rejects oversized or invalid UTF-8 source state before classification", () => {
    const oversizedRoot = workbench();
    writeFileSync(
      workflowSelectionPath(oversizedRoot),
      "x".repeat(64 * 1024 + 1),
    );
    expect(() => inspectWorkflowSelectionMigration(oversizedRoot))
      .toThrow(/exceeds the 65536-byte limit/i);

    const invalidRoot = workbench();
    writeFileSync(
      workflowSelectionPath(invalidRoot),
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    );
    expect(() => inspectWorkflowSelectionMigration(invalidRoot))
      .toThrow(/must be valid UTF-8/i);
  });
});

describe("workflow selection migration commit", () => {
  it("requires the exact current hash and leaves the source unchanged on mismatch", () => {
    const root = workbench();
    const raw = legacySelection();
    writeFileSync(workflowSelectionPath(root), raw);
    expect(() => migrateLegacyWorkflowSelection(root, {
      expectedSha256: "0".repeat(64),
      reason: "Expected hash mismatch test",
    })).toThrow(/SHA-256 mismatch/i);
    expect(readFileSync(workflowSelectionPath(root), "utf8")).toBe(raw);
    expect(existsSync(path.join(root, "state", "workflow-selection-archive"))).toBe(false);
    expect(existsSync(workflowSelectionLockPath(root))).toBe(false);
  });

  it("fails closed while another process owns the selection lease", async () => {
    const root = workbench();
    writeFileSync(workflowSelectionPath(root), legacySelection());
    const inspection = inspectWorkflowSelectionMigration(root);
    const holder = holdSelectionLock(root);
    await once(holder.stdout, "data");
    try {
      expect(() => migrateLegacyWorkflowSelection(root, {
        expectedSha256: inspection.sha256!,
        reason: "Selection lease contention test",
      })).toThrow(/busy/i);
      expect(existsSync(workflowSelectionPath(root))).toBe(true);
      expect(existsSync(path.join(root, "state", "workflow-selection-archive"))).toBe(false);
    } finally {
      holder.stdin.write("release\n");
      await once(holder, "exit");
    }
  });

  it("fails closed on an oversized selection lease", () => {
    const root = workbench();
    const raw = legacySelection();
    writeFileSync(workflowSelectionPath(root), raw);
    const inspection = inspectWorkflowSelectionMigration(root);
    writeFileSync(workflowSelectionLockPath(root), "x".repeat(16 * 1024 + 1));

    expect(() => migrateLegacyWorkflowSelection(root, {
      expectedSha256: inspection.sha256!,
      reason: "Oversized lease must not be recovered",
    })).toThrow(/exceeds the 16384-byte limit/i);
    expect(readFileSync(workflowSelectionPath(root), "utf8")).toBe(raw);
  });

  it("archives exact bytes, writes a bound receipt, and supports idempotent inspection", () => {
    const root = workbench();
    const raw = legacySelection();
    writeFileSync(workflowSelectionPath(root), raw);
    const inspection = inspectWorkflowSelectionMigration(root);
    const result = migrateLegacyWorkflowSelection(root, {
      expectedSha256: inspection.sha256!,
      reason: "Archive obsolete untrusted selection",
    });
    const paths = workflowSelectionArchivePaths(root, inspection.sha256!);
    expect(result.status).toBe("archived");
    expect(readFileSync(paths.archive)).toEqual(Buffer.from(raw));
    expect(JSON.parse(readFileSync(paths.receipt, "utf8"))).toMatchObject({
      receiptVersion: 1,
      receiptKind: "workflow-selection-legacy-archive",
      selectionSha256: inspection.sha256,
      selectionByteLength: Buffer.byteLength(raw),
      legacySchemaVersion: 0,
      legacyWorkflowId: "variants/default-debate-v2",
      operatorReason: "Archive obsolete untrusted selection",
    });
    expect(existsSync(workflowSelectionPath(root))).toBe(false);
    expect(existsSync(workflowSelectionLockPath(root))).toBe(false);
    expect(existsSync(`${workflowSelectionLockPath(root)}.recovery`)).toBe(false);
    expect(readdirSync(path.join(root, "state"))).not.toContainEqual(expect.stringMatching(/\.tmp|rollback-|preimage-/));

    const repeated = migrateLegacyWorkflowSelection(root, {
      expectedSha256: inspection.sha256!,
      reason: "A different retry reason does not rewrite evidence",
    });
    expect(repeated.status).toBe("already_archived");
    expect(repeated.receiptSha256).toBe(result.receiptSha256);
  });

  it("finishes a prepared archive without overwriting it", () => {
    const root = workbench();
    const raw = legacySelection("default");
    writeFileSync(workflowSelectionPath(root), raw);
    const inspection = inspectWorkflowSelectionMigration(root);
    const paths = workflowSelectionArchivePaths(root, inspection.sha256!);
    mkdirSync(path.dirname(paths.archive), { recursive: true });
    writeFileSync(paths.archive, raw, { flag: "wx" });

    const result = migrateLegacyWorkflowSelection(root, {
      expectedSha256: inspection.sha256!,
      reason: "Finish interrupted archive migration",
    });
    expect(result.status).toBe("archived");
    expect(readFileSync(paths.archive, "utf8")).toBe(raw);
    expect(existsSync(paths.receipt)).toBe(true);
    expect(existsSync(workflowSelectionPath(root))).toBe(false);
  });

  it("finishes receipt creation after a crash removed the source", () => {
    const root = workbench();
    const raw = legacySelection("default");
    writeFileSync(workflowSelectionPath(root), raw);
    const inspection = inspectWorkflowSelectionMigration(root);
    const paths = workflowSelectionArchivePaths(root, inspection.sha256!);
    mkdirSync(path.dirname(paths.archive), { recursive: true });
    writeFileSync(paths.archive, raw, { flag: "wx" });
    rmSync(workflowSelectionPath(root));

    const result = migrateLegacyWorkflowSelection(root, {
      expectedSha256: inspection.sha256!,
      reason: "Finalize receipt after interrupted removal",
    });
    expect(result.status).toBe("archived");
    expect(existsSync(paths.receipt)).toBe(true);
    expect(existsSync(workflowSelectionPath(root))).toBe(false);
  });

  it("refuses a source recreated after an immutable receipt was issued", () => {
    const root = workbench();
    const raw = legacySelection();
    writeFileSync(workflowSelectionPath(root), raw);
    const inspection = inspectWorkflowSelectionMigration(root);
    migrateLegacyWorkflowSelection(root, {
      expectedSha256: inspection.sha256!,
      reason: "Initial archival before recreation test",
    });
    writeFileSync(workflowSelectionPath(root), raw, { flag: "wx" });
    expect(() => migrateLegacyWorkflowSelection(root, {
      expectedSha256: inspection.sha256!,
      reason: "Do not erase a recreated source",
    })).toThrow(/recreated after migration/i);
    expect(readFileSync(workflowSelectionPath(root), "utf8")).toBe(raw);
  });

  it("rejects conflicting archive evidence without touching the source", () => {
    const root = workbench();
    const raw = legacySelection();
    writeFileSync(workflowSelectionPath(root), raw);
    const inspection = inspectWorkflowSelectionMigration(root);
    const paths = workflowSelectionArchivePaths(root, inspection.sha256!);
    mkdirSync(path.dirname(paths.archive), { recursive: true });
    writeFileSync(paths.archive, legacySelection("foreign"));
    expect(() => migrateLegacyWorkflowSelection(root, {
      expectedSha256: inspection.sha256!,
      reason: "Conflicting archive evidence test",
    })).toThrow(/archive hash conflicts/i);
    expect(readFileSync(workflowSelectionPath(root), "utf8")).toBe(raw);
    expect(existsSync(paths.receipt)).toBe(false);
  });

  it("refuses migration while a live daemon marker is present", () => {
    const root = workbench();
    const raw = legacySelection();
    writeFileSync(workflowSelectionPath(root), raw);
    const inspection = inspectWorkflowSelectionMigration(root);
    writeFileSync(path.join(root, "state", "juno-daemon.pid"), String(process.pid));
    expect(() => migrateLegacyWorkflowSelection(root, {
      expectedSha256: inspection.sha256!,
      reason: "Live daemon exclusion test",
    })).toThrow(/requires stopped daemons/i);
    expect(readFileSync(workflowSelectionPath(root), "utf8")).toBe(raw);
  });

  it("refuses migration while a direct mission runner owns a launcher lease", () => {
    const root = workbench();
    const raw = legacySelection();
    writeFileSync(workflowSelectionPath(root), raw);
    const inspection = inspectWorkflowSelectionMigration(root);
    const launcherRoot = path.join(root, "state", "run-launchers");
    mkdirSync(launcherRoot, { recursive: true });
    writeFileSync(
      path.join(launcherRoot, "active-run.lock.json"),
      `${JSON.stringify({ token: "active", pid: process.pid, acquiredAt: Date.now() })}\n`,
    );
    expect(() => migrateLegacyWorkflowSelection(root, {
      expectedSha256: inspection.sha256!,
      reason: "Live launcher exclusion test",
    })).toThrow(/requires idle run launchers/i);
    expect(readFileSync(workflowSelectionPath(root), "utf8")).toBe(raw);
  });
});

describe("workflow selection migration CLI arguments", () => {
  it("defaults to read-only inspection and requires both commit confirmations", async () => {
    const { parseWorkflowSelectionMigrationArgs } = await import(
      "../../../scripts/lib/workflow-selection-migration-args.mjs"
    );
    expect(parseWorkflowSelectionMigrationArgs([])).toEqual({
      commit: false,
      expectedSha256: null,
      reason: null,
      skipBuild: false,
    });
    expect(() => parseWorkflowSelectionMigrationArgs(["--commit"])).toThrow(/requires/i);
    expect(() => parseWorkflowSelectionMigrationArgs([
      "--commit",
      `--expected-sha256=${"0".repeat(64)}`,
    ])).toThrow(/requires/i);
    expect(() => parseWorkflowSelectionMigrationArgs([
      `--expected-sha256=${"0".repeat(64)}`,
    ])).toThrow(/only valid with --commit/i);
    expect(parseWorkflowSelectionMigrationArgs([
      "--commit",
      `--expected-sha256=${"A".repeat(64)}`,
      "--reason=Operator-confirmed legacy archive",
      "--skip-build",
    ])).toMatchObject({ commit: true, skipBuild: true });
  });
});
