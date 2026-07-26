import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const DAEMON_PROTOCOL_VERSION = 2;
export const MAX_DAEMON_STATE_BYTES = 256 * 1024;
export const MAX_DAEMON_LEASE_BYTES = 16 * 1024;
export const MAX_DAEMON_PID_BYTES = 64;
export const MAX_LIFECYCLE_LOCK_BYTES = 16 * 1024;
export const LIFECYCLE_LOCK_STALE_MS = 30_000;
export const LIFECYCLE_LOCK_WAIT_MS = 15_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sleepArray = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(sleepArray, 0, 0, ms);
}

function errorCode(error) {
  return error && typeof error === "object" ? error.code : undefined;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertExclusiveRegularFile(stat, target, label, maxBytes) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error(`${label} must be an exclusive regular file: ${target}`);
  }
  if (stat.size > BigInt(maxBytes)) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit: ${target}`);
  }
}

function sameIdentity(left, right) {
  return (
    (process.platform === "win32" || left.dev === right.dev)
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

export function sameControlSnapshot(left, right) {
  return Boolean(
    left
      && right
      && left.byteLength === right.byteLength
      && left.sha256 === right.sha256
      && (process.platform === "win32" || left.identity.dev === right.identity.dev)
      && left.identity.ino === right.identity.ino
      && left.identity.size === right.identity.size
      && left.identity.mtimeNs === right.identity.mtimeNs,
  );
}

export function readDaemonControlText(target, label, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`Invalid ${label} byte limit: ${maxBytes}`);
  }
  const before = lstatSync(target, { bigint: true });
  assertExclusiveRegularFile(before, target, label, maxBytes);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(target, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertExclusiveRegularFile(opened, target, label, maxBytes);
    if (!sameIdentity(before, opened)) throw new Error(`${label} changed while opening: ${target}`);

    const buffer = Buffer.alloc(maxBytes + 1);
    let byteLength = 0;
    while (byteLength < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        byteLength,
        buffer.length - byteLength,
        byteLength,
      );
      if (count === 0) break;
      byteLength += count;
    }
    if (byteLength > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit: ${target}`);
    }

    const afterHandle = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(target, { bigint: true });
    assertExclusiveRegularFile(afterHandle, target, label, maxBytes);
    assertExclusiveRegularFile(afterPath, target, label, maxBytes);
    if (!sameIdentity(opened, afterHandle) || !sameIdentity(afterHandle, afterPath)) {
      throw new Error(`${label} changed while reading: ${target}`);
    }
    if (afterHandle.size !== BigInt(byteLength)) {
      throw new Error(`${label} size changed while reading: ${target}`);
    }

    const bytes = buffer.subarray(0, byteLength);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`${label} must be valid UTF-8: ${target}`, { cause: error });
    }
    return {
      text,
      byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      identity: afterHandle,
    };
  } finally {
    closeSync(descriptor);
  }
}

export function readOptionalDaemonControlText(target, label, maxBytes) {
  try {
    return readDaemonControlText(target, label, maxBytes);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

export function parseDaemonControlJson(snapshot, label) {
  let value;
  try {
    value = JSON.parse(snapshot.text);
  } catch (error) {
    throw new Error(`${label} is malformed JSON`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

export function canonicalDaemonRoots(workbench, create = false) {
  if (create) {
    mkdirSync(workbench, { recursive: true });
    mkdirSync(path.join(workbench, "state"), { recursive: true });
  }
  const canonicalWorkbench = realpathSync.native(workbench);
  const stateDir = path.join(canonicalWorkbench, "state");
  const stateStat = lstatSync(stateDir);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    throw new Error(`Workbench state root must be a direct directory: ${stateDir}`);
  }
  const canonicalState = realpathSync.native(stateDir);
  if (path.dirname(canonicalState).toLowerCase() !== canonicalWorkbench.toLowerCase()) {
    throw new Error(`Workbench state root must be a direct child: ${canonicalState}`);
  }
  return { workbenchRoot: canonicalWorkbench, stateDir: canonicalState };
}

export function daemonControlPaths(stateDir) {
  return {
    state: path.join(stateDir, "juno-daemon.json"),
    lease: path.join(stateDir, "juno-daemon.lease.json"),
    pid: path.join(stateDir, "juno-daemon.pid"),
    lifecycle: path.join(stateDir, "juno-daemon.lifecycle.lock.json"),
  };
}

export function daemonProcessStartedAt(pid = process.pid) {
  if (pid !== process.pid) throw new Error("Only the current process start time is available");
  return Math.max(1, Math.floor(Date.now() - process.uptime() * 1000));
}

export function createDaemonIdentity(workbenchRoot, pid = process.pid) {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    generation: randomUUID(),
    pid,
    processStartedAt: daemonProcessStartedAt(pid),
    workbenchRoot,
  };
}

export function validateDaemonIdentity(value, label = "Daemon control") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  if (value.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
    throw new Error(`${label} protocolVersion must be ${DAEMON_PROTOCOL_VERSION}`);
  }
  if (typeof value.generation !== "string" || !UUID_PATTERN.test(value.generation)) {
    throw new Error(`${label} generation must be a UUID`);
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error(`${label} pid must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(value.processStartedAt) || value.processStartedAt <= 0) {
    throw new Error(`${label} processStartedAt must be a positive millisecond timestamp`);
  }
  if (
    typeof value.workbenchRoot !== "string"
    || value.workbenchRoot.length === 0
    || value.workbenchRoot.trim() !== value.workbenchRoot
  ) {
    throw new Error(`${label} workbenchRoot must be a non-empty canonical path`);
  }
  return value;
}

export function sameDaemonIdentity(left, right) {
  return (
    left.protocolVersion === right.protocolVersion
    && left.generation === right.generation
    && left.pid === right.pid
    && left.processStartedAt === right.processStartedAt
    && path.resolve(left.workbenchRoot).toLowerCase() === path.resolve(right.workbenchRoot).toLowerCase()
  );
}

function restoreQuarantine(quarantine, target, label) {
  try {
    linkSync(quarantine, target);
    unlinkSync(quarantine);
    return;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error(`${label} foreign generation was retained at ${quarantine} because the target is occupied`);
    }
    throw new Error(`${label} foreign generation cannot be restored from ${quarantine}`, {
      cause: error,
    });
  }
}

export function publishDaemonControlText(
  target,
  text,
  label,
  maxBytes,
  expected = null,
  hooks = {},
) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit: ${target}`);
  }
  const nonce = `${process.pid}-${randomUUID()}`;
  const staged = `${target}.staged-${nonce}`;
  const quarantine = `${target}.preimage-${nonce}`;
  let claimed = false;
  let installed = false;
  try {
    writeFileSync(staged, bytes, { flag: "wx" });
    const stagedSnapshot = readDaemonControlText(staged, `${label} staged update`, maxBytes);

    if (expected) {
      renameSync(target, quarantine);
      claimed = true;
      hooks.afterClaim?.();
      const moved = readDaemonControlText(quarantine, `${label} claimed preimage`, maxBytes);
      if (!sameControlSnapshot(expected, moved)) {
        restoreQuarantine(quarantine, target, label);
        claimed = false;
        throw new Error(`${label} changed during update claim`);
      }
    } else if (existsSync(target)) {
      throw new Error(`${label} appeared before exclusive creation: ${target}`);
    }

    hooks.beforeInstall?.();
    linkSync(staged, target);
    installed = true;
    unlinkSync(staged);
    const installedSnapshot = readDaemonControlText(target, label, maxBytes);
    if (installedSnapshot.sha256 !== stagedSnapshot.sha256) {
      throw new Error(`${label} installed bytes do not match the staged update`);
    }
    if (claimed) {
      unlinkSync(quarantine);
      claimed = false;
    }
    return installedSnapshot;
  } catch (error) {
    if (claimed && !installed) {
      try {
        restoreQuarantine(quarantine, target, label);
        claimed = false;
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `${label} update failed and its preimage could not be restored`);
      }
    }
    throw error;
  } finally {
    try {
      unlinkSync(staged);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        // A staged residue is diagnostic and remains fail-closed.
      }
    }
  }
}

export function publishDaemonControlJson(
  target,
  value,
  label,
  maxBytes,
  expected = null,
  hooks = {},
) {
  return publishDaemonControlText(
    target,
    `${JSON.stringify(value, null, 2)}\n`,
    label,
    maxBytes,
    expected,
    hooks,
  );
}

export function removeDaemonControlSnapshot(target, label, maxBytes, expected, hooks = {}) {
  const quarantine = `${target}.cleanup-${process.pid}-${randomUUID()}`;
  renameSync(target, quarantine);
  hooks.afterClaim?.();
  const moved = readDaemonControlText(quarantine, `${label} cleanup claim`, maxBytes);
  if (!sameControlSnapshot(expected, moved)) {
    restoreQuarantine(quarantine, target, label);
    throw new Error(`${label} changed during cleanup claim`);
  }
  hooks.beforeRemove?.();
  unlinkSync(quarantine);
}

function validateLifecycleLock(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Daemon lifecycle lock must be a JSON object");
  }
  if (value.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
    throw new Error("Daemon lifecycle lock protocolVersion must be 2");
  }
  if (typeof value.token !== "string" || !UUID_PATTERN.test(value.token)) {
    throw new Error("Daemon lifecycle lock token must be a UUID");
  }
  if (!Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0) {
    throw new Error("Daemon lifecycle lock ownerPid must be positive");
  }
  if (!Number.isSafeInteger(value.processStartedAt) || value.processStartedAt <= 0) {
    throw new Error("Daemon lifecycle lock processStartedAt must be positive");
  }
  if (!Number.isSafeInteger(value.acquiredAtMs) || value.acquiredAtMs <= 0) {
    throw new Error("Daemon lifecycle lock acquiredAtMs must be positive");
  }
  return value;
}

function readLifecycleLock(target) {
  const snapshot = readDaemonControlText(
    target,
    "Daemon lifecycle lock",
    MAX_LIFECYCLE_LOCK_BYTES,
  );
  return {
    snapshot,
    value: validateLifecycleLock(parseDaemonControlJson(snapshot, "Daemon lifecycle lock")),
  };
}

function tryCreateLifecycleLock(target, operation, token) {
  let descriptor;
  try {
    descriptor = openSync(target, "wx");
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        token,
        ownerPid: process.pid,
        processStartedAt: daemonProcessStartedAt(),
        acquiredAtMs: Date.now(),
        operation,
      }, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (errorCode(error) === "EEXIST") return null;
    throw error;
  }
  closeSync(descriptor);
  const lock = readLifecycleLock(target);
  if (lock.value.token !== token) throw new Error("Daemon lifecycle lock changed after creation");
  return { ...lock, target, borrowed: false };
}

function reclaimStaleLifecycleLock(target, observed) {
  if (
    processIsAlive(observed.value.ownerPid)
    || Date.now() - observed.value.acquiredAtMs <= LIFECYCLE_LOCK_STALE_MS
  ) {
    return false;
  }
  try {
    removeDaemonControlSnapshot(
      target,
      "Daemon lifecycle lock",
      MAX_LIFECYCLE_LOCK_BYTES,
      observed.snapshot,
    );
    return true;
  } catch {
    return false;
  }
}

export function acquireDaemonLifecycleLock(
  stateDir,
  operation,
  { timeoutMs = LIFECYCLE_LOCK_WAIT_MS, handoffToken = process.env.JUNO_LIFECYCLE_HANDOFF_TOKEN } = {},
) {
  const target = daemonControlPaths(stateDir).lifecycle;
  if (handoffToken) {
    const borrowed = readLifecycleLock(target);
    if (borrowed.value.token !== handoffToken) {
      throw new Error("Daemon lifecycle handoff token does not match the shared lock");
    }
    return { ...borrowed, target, borrowed: true };
  }

  const started = Date.now();
  const token = randomUUID();
  while (Date.now() - started <= timeoutMs) {
    const created = tryCreateLifecycleLock(target, operation, token);
    if (created) return created;
    try {
      const observed = readLifecycleLock(target);
      if (reclaimStaleLifecycleLock(target, observed)) continue;
    } catch {
      try {
        const age = Date.now() - statSync(target).mtimeMs;
        if (age > LIFECYCLE_LOCK_STALE_MS) {
          throw new Error(`Daemon lifecycle lock is stale but malformed: ${target}`);
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        if (error instanceof Error && error.message.includes("stale but malformed")) throw error;
      }
    }
    sleepSync(25);
  }
  throw new Error(`Timed out acquiring daemon lifecycle lock for ${operation}`);
}

export function releaseDaemonLifecycleLock(lock) {
  if (lock.borrowed) return;
  removeDaemonControlSnapshot(
    lock.target,
    "Daemon lifecycle lock",
    MAX_LIFECYCLE_LOCK_BYTES,
    lock.snapshot,
  );
}

export function withDaemonLifecycleLock(stateDir, operation, callback, options) {
  const lock = acquireDaemonLifecycleLock(stateDir, operation, options);
  try {
    return callback(lock);
  } finally {
    releaseDaemonLifecycleLock(lock);
  }
}

export function parseLegacyPidSnapshot(snapshot) {
  const text = snapshot.text.trim();
  if (!/^\d+$/.test(text)) throw new Error("Daemon legacy PID must contain one decimal PID");
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Daemon legacy PID must be a positive safe integer");
  }
  return pid;
}

export function inspectDaemonV2Control(workbenchRoot, stateDir) {
  const paths = daemonControlPaths(stateDir);
  const stateFirst = readOptionalDaemonControlText(
    paths.state,
    "Daemon state",
    MAX_DAEMON_STATE_BYTES,
  );
  const leaseSnapshot = readOptionalDaemonControlText(
    paths.lease,
    "Daemon lease",
    MAX_DAEMON_LEASE_BYTES,
  );
  const pidSnapshot = readOptionalDaemonControlText(paths.pid, "Daemon PID", MAX_DAEMON_PID_BYTES);
  const stateSecond = readOptionalDaemonControlText(
    paths.state,
    "Daemon state",
    MAX_DAEMON_STATE_BYTES,
  );

  if (Boolean(stateFirst) !== Boolean(stateSecond)) {
    throw new Error("Daemon state appeared or disappeared during state/lease/state read");
  }
  if (stateFirst && !sameControlSnapshot(stateFirst, stateSecond)) {
    throw new Error("Daemon state changed during state/lease/state read");
  }
  const state = stateFirst ? parseDaemonControlJson(stateFirst, "Daemon state") : null;
  if (!state || state.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
    if (leaseSnapshot) throw new Error("Daemon v2 lease is present without v2 state");
    return { kind: state ? "legacy" : "missing", state, stateSnapshot: stateFirst, pidSnapshot };
  }

  const stateIdentity = validateDaemonIdentity(state, "Daemon state");
  const terminalWithoutLease = state.status === "blocked" || state.status === "stopped";
  if (!leaseSnapshot) {
    if (pidSnapshot) throw new Error("Daemon v2 state has a PID shadow without a lease");
    if (!terminalWithoutLease) throw new Error("Enabled daemon v2 state has no lease");
    return { kind: "terminal-v2", state, stateSnapshot: stateFirst, identity: stateIdentity };
  }
  if (!pidSnapshot) throw new Error("Daemon v2 lease has no legacy PID shadow");
  const lease = parseDaemonControlJson(leaseSnapshot, "Daemon lease");
  const leaseIdentity = validateDaemonIdentity(lease, "Daemon lease");
  if (!sameDaemonIdentity(stateIdentity, leaseIdentity)) {
    throw new Error("Daemon state and lease generations do not match");
  }
  if (path.resolve(stateIdentity.workbenchRoot).toLowerCase() !== path.resolve(workbenchRoot).toLowerCase()) {
    throw new Error("Daemon controls are bound to a different Workbench");
  }
  if (parseLegacyPidSnapshot(pidSnapshot) !== stateIdentity.pid) {
    throw new Error("Daemon legacy PID shadow does not match the v2 lease");
  }
  return {
    kind: "v2",
    state,
    lease,
    identity: stateIdentity,
    stateSnapshot: stateFirst,
    leaseSnapshot,
    pidSnapshot,
    live: processIsAlive(stateIdentity.pid),
  };
}
