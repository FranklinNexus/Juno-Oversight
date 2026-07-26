import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReviseImplementItem } from "../../../orchestrator/src/mission-progress.js";
import { revisionFixRunId } from "../../../orchestrator/src/revision-lineage.js";
import {
  parseNowYaml,
  QueueFileError,
  queueMutationLockPath,
  readNowQueueSnapshot,
  recoverQueueHeadCommit,
  replaceQueueHeadConditionalWithCommit,
  replaceQueueHeadConditional,
  replaceQueueSnapshotConditional,
  saveNowQueue,
} from "../../../orchestrator/src/queue-io.js";

function queueItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    horizon: "day" as const,
    kind: "task",
    prompt: "executor_generic",
    ...overrides,
  };
}

function writeRawQueue(workbench: string, text: string): string {
  const queuePath = path.join(workbench, "queue", "now.yaml");
  mkdirSync(path.dirname(queuePath), { recursive: true });
  writeFileSync(queuePath, text, "utf8");
  return queuePath;
}

describe("queue-io", () => {
  it("round-trips model, allowed tools, quotes, backslashes, and multiline criteria", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-"));
    saveNowQueue(workbench, [
      {
        id: "run-1",
        horizon: "mission",
        kind: "implement",
        run_kind: "implement",
        prompt: "executor_generic",
        provider: "cursor_composer",
        model: "composer-2.5",
        allowed_tools: ["read", "shell:test"],
        success_criteria: "line one\nline two with \\\\ and \"quotes\"",
      },
    ]);
    const parsed = parseNowYaml(workbench).now[0];
    expect(parsed.model).toBe("composer-2.5");
    expect(parsed.allowed_tools).toEqual(["read", "shell:test"]);
    expect(parsed.success_criteria).toBe("line one\nline two with \\\\ and \"quotes\"");
    expect(readdirSync(path.join(workbench, "queue")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("atomically replaces an existing queue file", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-replace-"));
    const item = {
      id: "first",
      horizon: "day" as const,
      kind: "task",
      prompt: "executor_generic",
    };
    saveNowQueue(workbench, [item]);
    saveNowQueue(workbench, [{ ...item, id: "second" }]);

    expect(parseNowYaml(workbench).now.map((entry) => entry.id)).toEqual(["second"]);
    expect(readdirSync(path.join(workbench, "queue")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("distinguishes a missing queue from a valid empty queue", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-missing-"));
    expect(readNowQueueSnapshot(workbench)).toEqual({
      now: [],
      backlog: [],
      revision: null,
      source: "missing",
    });
    expect(parseNowYaml(workbench)).toEqual({ now: [], backlog: [] });

    writeRawQueue(workbench, "now: []\nbacklog: []\n");
    const empty = readNowQueueSnapshot(workbench);
    expect(empty).toMatchObject({ now: [], backlog: [], source: "file" });
    expect(empty.revision).toBe(
      createHash("sha256").update("now: []\nbacklog: []\n", "utf8").digest("hex"),
    );
  });

  it("rejects an external queue-root junction without reading or writing outside", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-root-link-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "juno-queue-root-outside-"));
    const externalQueue = path.join(outside, "queue");
    mkdirSync(externalQueue);
    const externalQueuePath = path.join(externalQueue, "now.yaml");
    const externalBytes = Buffer.from("now: []\nbacklog: []\n", "utf8");
    writeFileSync(externalQueuePath, externalBytes);
    symlinkSync(
      externalQueue,
      path.join(workbench, "queue"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const externalEntries = readdirSync(externalQueue);

    expect(() => readNowQueueSnapshot(workbench)).toThrow(/non-link|canonical containment/i);
    expect(() => saveNowQueue(workbench, [queueItem("must-not-escape")]))
      .toThrow(/non-link|canonical containment/i);
    expect(readFileSync(externalQueuePath)).toEqual(externalBytes);
    expect(readdirSync(externalQueue)).toEqual(externalEntries);
  });

  it("rejects an external state-root junction before creating a lease", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-state-root-link-"));
    const queuePath = writeRawQueue(workbench, "now: []\nbacklog: []\n");
    const queueBytes = readFileSync(queuePath);
    const outside = mkdtempSync(path.join(os.tmpdir(), "juno-state-root-outside-"));
    const externalState = path.join(outside, "state");
    mkdirSync(externalState);
    const sentinelPath = path.join(externalState, "sentinel.txt");
    writeFileSync(sentinelPath, "unchanged\n", "utf8");
    symlinkSync(
      externalState,
      path.join(workbench, "state"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const externalEntries = readdirSync(externalState);

    expect(() => saveNowQueue(workbench, [queueItem("must-not-lease-outside")]))
      .toThrow(/non-link|canonical containment/i);
    expect(readFileSync(queuePath)).toEqual(queueBytes);
    expect(readFileSync(sentinelPath, "utf8")).toBe("unchanged\n");
    expect(readdirSync(externalState)).toEqual(externalEntries);
  });

  it("rejects a hard-linked queue control file", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-hardlink-"));
    const source = path.join(workbench, "queue-source.yaml");
    writeFileSync(source, "now: []\nbacklog: []\n", "utf8");
    const queuePath = path.join(workbench, "queue", "now.yaml");
    mkdirSync(path.dirname(queuePath), { recursive: true });
    linkSync(source, queuePath);

    expect(() => readNowQueueSnapshot(workbench)).toThrow(/exclusive regular file/i);
    expect(readFileSync(source, "utf8")).toBe("now: []\nbacklog: []\n");
  });

  it.each([
    [
      "oversized bytes",
      Buffer.alloc(2 * 1024 * 1024 + 1, 0x20),
      /exceeds the 2097152-byte limit/i,
    ],
    ["invalid UTF-8", Buffer.from([0x6e, 0x6f, 0x77, 0x3a, 0x20, 0xff]), /valid UTF-8/i],
  ])("rejects queue control data with %s", (_label, bytes, expected) => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-control-"));
    const queuePath = path.join(workbench, "queue", "now.yaml");
    mkdirSync(path.dirname(queuePath), { recursive: true });
    writeFileSync(queuePath, bytes);

    expect(() => readNowQueueSnapshot(workbench)).toThrow(expected);
    expect(statSync(queuePath).size).toBe(bytes.byteLength);
  });

  it("rejects an oversized rendered queue before replacing the old bytes", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-write-limit-"));
    saveNowQueue(workbench, [queueItem("retained-head")]);
    const queuePath = path.join(workbench, "queue", "now.yaml");
    const before = readFileSync(queuePath);

    expect(() => saveNowQueue(workbench, [queueItem("oversized-writer", {
      success_criteria: "x".repeat(2 * 1024 * 1024),
    })])).toThrow(/rendered queue exceeds the 2097152-byte limit/i);
    expect(readFileSync(queuePath)).toEqual(before);
    expect(readdirSync(path.dirname(queuePath)).filter((name) => name.endsWith(".tmp")))
      .toEqual([]);
  });

  it.each([
    ["empty file", ""],
    ["garbage root", "this is not a queue\n"],
    ["invalid YAML", "now: [\nbacklog: []\n"],
    ["missing section", "now: []\n"],
    ["wrong section type", "now: nope\nbacklog: []\n"],
    [
      "invalid allowed tools",
      "now:\n  - id: bad-tools\n    allowed_tools: shell\nbacklog: []\n",
    ],
    [
      "invalid max minutes",
      "now:\n  - id: bad-time\n    max_minutes: nope\nbacklog: []\n",
    ],
    ["unknown item field", "now:\n  - id: typo\n    mission-id: bad\nbacklog: []\n"],
  ])("rejects an existing malformed queue: %s", (_label, text) => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-invalid-"));
    const queuePath = writeRawQueue(workbench, text);
    expect(() => parseNowYaml(workbench)).toThrow(QueueFileError);
    expect(readFileSync(queuePath, "utf8")).toBe(text);
  });

  it("rejects duplicate ids across now and backlog", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-duplicate-"));
    writeRawQueue(
      workbench,
      "now:\n  - id: duplicate\nbacklog:\n  - id: duplicate\n",
    );
    expect(() => parseNowYaml(workbench)).toThrow(/duplicate queue item id: duplicate/);
  });

  it("uses revision CAS and a complete head fingerprint without overwriting conflicts", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-cas-"));
    saveNowQueue(workbench, [queueItem("head"), queueItem("tail")]);
    const original = readNowQueueSnapshot(workbench);

    saveNowQueue(workbench, [queueItem("new-head"), ...original.now]);
    const queuePath = path.join(workbench, "queue", "now.yaml");
    const changedBytes = readFileSync(queuePath, "utf8");
    const staleCommit = replaceQueueHeadConditional(workbench, {
      expectedRevision: original.revision,
      expectedHead: original.now[0],
      replacement: [],
    });
    expect(staleCommit).toMatchObject({ ok: false, reason: "revision_conflict" });
    expect(readFileSync(queuePath, "utf8")).toBe(changedBytes);

    const current = readNowQueueSnapshot(workbench);
    const changedHead = { ...current.now[0], prompt: "different_prompt" };
    const wrongFingerprint = replaceQueueHeadConditional(workbench, {
      expectedRevision: current.revision,
      expectedHead: changedHead,
      replacement: [],
    });
    expect(wrongFingerprint).toMatchObject({ ok: false, reason: "head_mismatch" });
    expect(readFileSync(queuePath, "utf8")).toBe(changedBytes);

    const committed = replaceQueueHeadConditional(workbench, {
      expectedRevision: current.revision,
      expectedHead: current.now[0],
      replacement: [queueItem("fix")],
    });
    expect(committed.ok).toBe(true);
    expect(parseNowYaml(workbench).now.map((item) => item.id)).toEqual(["fix", "head", "tail"]);
  });

  it("accepts a fully bound experiment revise item and rejects a missing fixture binding", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-experiment-revise-"));
    const review = queueItem("wfexp-review", {
      horizon: "mission",
      kind: "review",
      run_kind: "review",
      repo_target: "workbench",
      prompt: "executor_book_review",
      provider: "openai_codex",
      mission_id: "juno-workflow-canary-sample",
      phase_id: "candidate-review",
      workflow_id: "variants/axiom-book-lean-v2",
      eval_profile: "literature",
      experiment_id: "wfexp-review-binding",
      experiment_arm: "candidate",
      experiment_episode: 1,
      source_phase_id: "book-workflow-canary",
      experiment_fixture_sha256: "b".repeat(64),
      experiment_prompt_sha256: "c".repeat(64),
    });
    saveNowQueue(workbench, [review]);
    const snapshot = readNowQueueSnapshot(workbench);
    const fix = buildReviseImplementItem(
      snapshot.now[0],
      7,
      ["repair evidence"],
      {
        experimentId: review.experiment_id!,
        promptSha256ByTemplate: {
          executor_book_review: "c".repeat(64),
          executor_book_write: "d".repeat(64),
        },
      },
    );

    const committed = replaceQueueHeadConditional(workbench, {
      expectedRevision: snapshot.revision,
      expectedHead: snapshot.now[0],
      replacement: [fix],
    });
    expect(committed.ok).toBe(true);
    expect(parseNowYaml(workbench).now[0]).toMatchObject({
      id: revisionFixRunId(review.id, 7),
      experiment_id: "wfexp-review-binding",
      experiment_fixture_sha256: "b".repeat(64),
      experiment_prompt_sha256: "d".repeat(64),
      revision_of: review.id,
      revision_attempt: 7,
    });

    const queuePath = path.join(workbench, "queue", "now.yaml");
    const before = readFileSync(queuePath, "utf8");
    const incomplete = { ...fix };
    delete incomplete.experiment_fixture_sha256;
    expect(() => saveNowQueue(workbench, [incomplete])).toThrow(/complete bindings/i);
    expect(readFileSync(queuePath, "utf8")).toBe(before);

    expect(() => saveNowQueue(workbench, [{
      ...fix,
      experiment_prompt_sha256: "not-a-hash",
    }])).toThrow(/experiment_prompt_sha256 must be SHA-256/i);
  });

  it("rejects incomplete, unsafe, unbounded, and mismatched revision lineage", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-revision-invalid-"));
    const parent = "review-parent";
    const valid = queueItem(revisionFixRunId(parent, 1), {
      kind: "implement",
      run_kind: "implement",
      revision_of: parent,
      revision_attempt: 1,
    });
    expect(() => saveNowQueue(workbench, [valid])).not.toThrow();
    expect(() => saveNowQueue(workbench, [{ ...valid, revision_attempt: undefined }])).toThrow(
      /revision_attempt/i,
    );
    expect(() => saveNowQueue(workbench, [{ ...valid, revision_of: "../escape" }])).toThrow(
      /safe run id/i,
    );
    expect(() => saveNowQueue(workbench, [{ ...valid, revision_attempt: 21 }])).toThrow(
      /bounded positive integer/i,
    );
    expect(() => saveNowQueue(workbench, [{ ...valid, id: "forged-revision" }])).toThrow(
      /does not match/i,
    );
  });

  it("conditionally replaces an empty-head snapshot for promotion and rejects stale rollback", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-snapshot-cas-"));
    saveNowQueue(workbench, [], [queueItem("promote"), queueItem("later")]);
    const emptyHead = readNowQueueSnapshot(workbench);
    const promoted = replaceQueueSnapshotConditional(workbench, {
      expectedRevision: emptyHead.revision,
      now: [emptyHead.backlog[0]],
      backlog: emptyHead.backlog.slice(1),
    });
    expect(promoted.ok).toBe(true);
    expect(parseNowYaml(workbench)).toMatchObject({
      now: [{ id: "promote" }],
      backlog: [{ id: "later" }],
    });

    if (!promoted.ok) throw new Error("promotion did not commit");
    saveNowQueue(workbench, [queueItem("concurrent"), ...promoted.current.now], promoted.current.backlog);
    const queuePath = path.join(workbench, "queue", "now.yaml");
    const concurrentBytes = readFileSync(queuePath, "utf8");
    const staleRollback = replaceQueueSnapshotConditional(workbench, {
      expectedRevision: promoted.current.revision,
      now: promoted.previous.now,
      backlog: promoted.previous.backlog,
    });
    expect(staleRollback).toMatchObject({ ok: false, reason: "revision_conflict" });
    expect(readFileSync(queuePath, "utf8")).toBe(concurrentBytes);
  });

  it("retains foreign target and exact preimage when forward publish loses exclusive install", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-forward-preimage-"));
    saveNowQueue(workbench, [queueItem("head"), queueItem("tail")]);
    const original = readNowQueueSnapshot(workbench);
    const queuePath = path.join(workbench, "queue", "now.yaml");
    const originalBytes = readFileSync(queuePath);
    const foreignBytes = Buffer.from(
      "now:\n  - id: foreign-forward-writer\n    horizon: day\n    kind: task\n    prompt: executor_generic\nbacklog: []\n",
      "utf8",
    );
    let commitCalled = false;

    expect(() => replaceQueueHeadConditionalWithCommit(
      workbench,
      {
        expectedRevision: original.revision,
        expectedHead: original.now[0],
        replacement: [],
      },
      () => {
        commitCalled = true;
        return "committed";
      },
      {
        afterPreimageMoved: ({ targetPath }) => {
          writeFileSync(targetPath, foreignBytes, { flag: "wx" });
        },
      },
    )).toThrow(/concurrent queue writer won the commit/i);

    expect(commitCalled).toBe(false);
    expect(readFileSync(queuePath)).toEqual(foreignBytes);
    const preimages = readdirSync(path.dirname(queuePath))
      .filter((name) => name.startsWith("now.yaml.preimage-"));
    expect(preimages).toHaveLength(1);
    expect(readFileSync(path.join(path.dirname(queuePath), preimages[0])))
      .toEqual(originalBytes);
    expect(() => readNowQueueSnapshot(workbench)).toThrow(/orphaned preimage/i);
    expect(() => saveNowQueue(workbench, [queueItem("must-not-overwrite")]))
      .toThrow(/orphaned preimage/i);
    expect(readFileSync(queuePath)).toEqual(foreignBytes);
    expect(readFileSync(path.join(path.dirname(queuePath), preimages[0])))
      .toEqual(originalBytes);
  });

  it("restores the exact queue preimage when publishing aborts before install", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-preimage-restore-"));
    saveNowQueue(workbench, [queueItem("head"), queueItem("tail")]);
    const original = readNowQueueSnapshot(workbench);
    const queuePath = path.join(workbench, "queue", "now.yaml");
    const originalBytes = readFileSync(queuePath);
    let commitCalled = false;

    expect(() => replaceQueueHeadConditionalWithCommit(
      workbench,
      {
        expectedRevision: original.revision,
        expectedHead: original.now[0],
        replacement: [],
      },
      () => {
        commitCalled = true;
        return "committed";
      },
      {
        afterPreimageMoved: () => {
          throw new Error("injected publish abort");
        },
      },
    )).toThrow(/injected publish abort/i);

    expect(commitCalled).toBe(false);
    expect(readFileSync(queuePath)).toEqual(originalBytes);
    expect(readNowQueueSnapshot(workbench).revision).toBe(original.revision);
    expect(readdirSync(path.dirname(queuePath)).filter((name) =>
      name.startsWith("now.yaml.preimage-") || name.endsWith(".tmp")
    )).toEqual([]);
  });

  it("does not roll a failed commit over a foreign queue revision", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-commit-race-"));
    saveNowQueue(workbench, [queueItem("terminal"), queueItem("tail")]);
    const original = readNowQueueSnapshot(workbench);
    const foreign = queueItem("foreign-writer");

    const result = replaceQueueHeadConditionalWithCommit(
      workbench,
      {
        expectedRevision: original.revision,
        expectedHead: original.now[0],
        replacement: [],
      },
      () => {
        writeRawQueue(
          workbench,
          `now:\n  - id: ${foreign.id}\n    horizon: day\n    kind: task\n    prompt: executor_generic\nbacklog: []\n`,
        );
        throw new Error("receipt storage failed");
      },
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "commit_failed",
      restored: false,
      current: { now: [{ id: foreign.id }] },
    });
    expect(parseNowYaml(workbench).now).toEqual([foreign]);
  });

  it("blocks recovery when the prepared queue file disappeared", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-recovery-missing-"));
    const head = queueItem("prepared-head", { mission_id: "prepared-mission" });
    saveNowQueue(workbench, [head]);
    const queuePath = path.join(workbench, "queue", "now.yaml");
    const receiptPath = path.join(workbench, "completion-receipt.json");
    rmSync(queuePath);

    const result = recoverQueueHeadCommit(workbench, head, () => {
      writeFileSync(receiptPath, "committed\n", { flag: "wx" });
      return "committed";
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "conflict",
      current: { source: "missing", revision: null },
    });
    expect(existsSync(receiptPath)).toBe(false);
    expect(existsSync(queuePath)).toBe(false);
  });

  it("retains foreign target and exact preimage when rollback loses exclusive install", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-rollback-preimage-"));
    saveNowQueue(workbench, [queueItem("terminal"), queueItem("tail")]);
    const original = readNowQueueSnapshot(workbench);
    const queuePath = path.join(workbench, "queue", "now.yaml");
    const foreignBytes = Buffer.from(
      "now:\n  - id: foreign-after-quarantine\n    horizon: day\n    kind: task\n    prompt: executor_generic\nbacklog: []\n",
      "utf8",
    );
    let rollbackPreimage: Buffer | null = null;
    let moved = 0;

    expect(() => replaceQueueHeadConditionalWithCommit(
      workbench,
      {
        expectedRevision: original.revision,
        expectedHead: original.now[0],
        replacement: [],
      },
      () => {
        rollbackPreimage = readFileSync(queuePath);
        throw new Error("receipt storage failed");
      },
      {
        afterPreimageMoved: ({ targetPath }) => {
          moved += 1;
          if (moved === 2) writeFileSync(targetPath, foreignBytes, { flag: "wx" });
        },
      },
    )).toThrow(/orphaned preimage/i);

    expect(moved).toBe(2);
    expect(readFileSync(queuePath)).toEqual(foreignBytes);
    const preimages = readdirSync(path.dirname(queuePath))
      .filter((name) => name.startsWith("now.yaml.preimage-"));
    expect(preimages).toHaveLength(1);
    expect(rollbackPreimage).not.toBeNull();
    expect(readFileSync(path.join(path.dirname(queuePath), preimages[0])))
      .toEqual(rollbackPreimage);
    expect(() => readNowQueueSnapshot(workbench)).toThrow(/orphaned preimage/i);
    expect(() => saveNowQueue(workbench, [queueItem("must-not-overwrite")]))
      .toThrow(/orphaned preimage/i);
    expect(readFileSync(queuePath)).toEqual(foreignBytes);
    expect(readFileSync(path.join(path.dirname(queuePath), preimages[0])))
      .toEqual(rollbackPreimage);
  });

  it("reports a live queue mutation lease as busy without changing the queue", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-busy-"));
    saveNowQueue(workbench, [queueItem("head")]);
    const snapshot = readNowQueueSnapshot(workbench);
    const queuePath = path.join(workbench, "queue", "now.yaml");
    const before = readFileSync(queuePath, "utf8");
    const lockPath = queueMutationLockPath(workbench);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({ token: randomUUID(), pid: process.pid, acquiredAt: Date.now() })}\n`,
      "utf8",
    );

    try {
      expect(
        replaceQueueHeadConditional(workbench, {
          expectedRevision: snapshot.revision,
          expectedHead: snapshot.now[0],
          replacement: [],
        }),
      ).toEqual({ ok: false, reason: "busy" });
      expect(
        replaceQueueSnapshotConditional(workbench, {
          expectedRevision: snapshot.revision,
          now: [],
          backlog: [],
        }),
      ).toEqual({ ok: false, reason: "busy" });
      expect(readFileSync(queuePath, "utf8")).toBe(before);
    } finally {
      rmSync(lockPath, { force: true });
    }
  });

  it("rejects a hard-linked queue mutation lease without changing the queue", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-lock-hardlink-"));
    saveNowQueue(workbench, [queueItem("head")]);
    const queuePath = path.join(workbench, "queue", "now.yaml");
    const before = readFileSync(queuePath);
    const lockPath = queueMutationLockPath(workbench);
    const source = path.join(workbench, "state", "foreign-lock.json");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(source, "{}\n", "utf8");
    linkSync(source, lockPath);

    expect(() => saveNowQueue(workbench, [queueItem("replacement")])).toThrow(
      /exclusive regular file/i,
    );
    expect(readFileSync(queuePath)).toEqual(before);
  });

  it.each([
    [
      "oversized bytes",
      Buffer.alloc(16 * 1024 + 1, 0x20),
      /exceeds the 16384-byte limit/i,
    ],
    ["invalid UTF-8", Buffer.from([0x7b, 0xff, 0x7d]), /valid UTF-8/i],
  ])("rejects a queue mutation lease with %s", (_label, bytes, expected) => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-queue-lock-control-"));
    saveNowQueue(workbench, [queueItem("head")]);
    const queuePath = path.join(workbench, "queue", "now.yaml");
    const before = readFileSync(queuePath);
    const lockPath = queueMutationLockPath(workbench);
    writeFileSync(lockPath, bytes);

    expect(() => saveNowQueue(workbench, [queueItem("replacement")])).toThrow(expected);
    expect(readFileSync(queuePath)).toEqual(before);
    expect(readFileSync(lockPath)).toEqual(bytes);
  });
});
