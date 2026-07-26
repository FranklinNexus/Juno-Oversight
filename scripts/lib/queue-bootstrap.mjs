import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnPnpmWithTimeout } from "./pnpm-runner.mjs";
import {
  BUILD_TIMEOUT_MS,
  requireSpawnSuccess,
} from "./specialized-loop-guard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let queueIoPromise;

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertWorkbench(workbench) {
  if (typeof workbench !== "string" || workbench.trim() === "") {
    throw new Error("workbench must be a non-empty path");
  }
  return path.resolve(workbench);
}

function backupExpectedSnapshot(workbench, snapshot, prefix) {
  if (!prefix || snapshot.source === "missing") return null;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(prefix)) {
    throw new Error(`invalid queue backup prefix: ${prefix}`);
  }

  const queuePath = path.join(workbench, "queue", "now.yaml");
  const raw = readFileSync(queuePath, "utf8");
  if (sha256(raw) !== snapshot.revision) {
    const error = new Error("queue changed before its bootstrap backup could be captured");
    error.code = "QUEUE_REVISION_CONFLICT";
    throw error;
  }

  const backupPath = path.join(
    workbench,
    "queue",
    `now.yaml.${prefix}-${Date.now()}-${randomUUID()}.yaml`,
  );
  writeFileSync(backupPath, raw, { encoding: "utf8", flag: "wx" });
  return backupPath;
}

export async function loadStrictQueueIo() {
  if (!queueIoPromise) {
    queueIoPromise = (async () => {
      requireSpawnSuccess(
        await spawnPnpmWithTimeout(
          ["orchestrator:build"],
          { cwd: repoRoot, stdio: "inherit" },
          BUILD_TIMEOUT_MS,
        ),
        "orchestrator build",
      );
      const target = path.join(repoRoot, "orchestrator", "dist", "queue-io.js");
      return import(`${pathToFileURL(target).href}?built=${Date.now()}`);
    })();
  }
  return queueIoPromise;
}

export function replaceQueueSnapshotWithIo(queueIo, options) {
  const workbench = assertWorkbench(options.workbench);
  const snapshot = queueIo.readNowQueueSnapshot(workbench);

  if (options.onlyIfMissing && snapshot.source !== "missing") {
    return { changed: false, reason: "queue_exists", previous: snapshot, backupPath: null };
  }
  if (options.canReplace && !options.canReplace(snapshot)) {
    return { changed: false, reason: "replacement_declined", previous: snapshot, backupPath: null };
  }

  const backupPath = backupExpectedSnapshot(workbench, snapshot, options.backupPrefix);
  const result = queueIo.replaceQueueSnapshotConditional(workbench, {
    expectedRevision: snapshot.revision,
    now: options.now,
    backlog: options.backlog ?? [],
  });
  if (!result.ok) {
    const error = new Error(`queue bootstrap CAS failed: ${result.reason}`);
    error.code = result.reason === "busy" ? "QUEUE_MUTATION_BUSY" : "QUEUE_REVISION_CONFLICT";
    error.backupPath = backupPath;
    throw error;
  }
  return { changed: true, reason: "replaced", backupPath, ...result };
}

export async function replaceQueueSnapshotSafely(options) {
  const queueIo = options.queueIo ?? (await loadStrictQueueIo());
  return replaceQueueSnapshotWithIo(queueIo, options);
}
