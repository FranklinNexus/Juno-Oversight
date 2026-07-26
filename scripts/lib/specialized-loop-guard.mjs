import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TERMINAL_BLOCK_EXIT = 5;
export const BUILD_TIMEOUT_MS = 2 * 60_000;
export const BOOTSTRAP_TIMEOUT_MS = 2 * 60_000;
export const VERIFY_TIMEOUT_MS = 15 * 60_000;
export const LIVE_SLOT_TIMEOUT_MS = 30 * 60_000;
export const DAEMON_CYCLE_TIMEOUT_MS = 35 * 60_000;
export const DAEMON_ACTIVE_HEARTBEAT_MS = 60_000;
const PID_ACQUIRE_LOCK_STALE_MS = 30_000;
const SUBPROCESS_OUTPUT_LIMIT = 10 * 1024 * 1024;
const SPECIALIZED_DAEMON_STATUSES = new Set([
  "running",
  "retrying",
  "stopped",
  "complete",
  "terminal_blocked",
]);
const PID_LEASE_TOKEN = /^[a-f0-9-]{36}$/;
const CYCLE_NONCE = /^[a-zA-Z0-9_-]{16,128}$/;
const WINDOWS_TREE_TERMINATOR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "terminate-process-tree.ps1",
);

export function liveSlotTimeoutMs(maxMinutes, graceMinutes = 5) {
  if (!Number.isSafeInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 240) {
    throw new Error(`invalid live slot maxMinutes: ${maxMinutes}`);
  }
  if (!Number.isSafeInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 30) {
    throw new Error(`invalid live slot graceMinutes: ${graceMinutes}`);
  }
  return (maxMinutes + graceMinutes) * 60_000;
}

export function daemonCycleTimeoutMs(maxSlots, perSlotTimeoutMs) {
  if (!Number.isSafeInteger(maxSlots) || maxSlots < 1 || maxSlots > 200) {
    throw new Error(`invalid daemon cycle maxSlots: ${maxSlots}`);
  }
  if (!Number.isSafeInteger(perSlotTimeoutMs) || perSlotTimeoutMs < 1) {
    throw new Error(`invalid daemon per-slot timeout: ${perSlotTimeoutMs}`);
  }
  return Math.max(
    DAEMON_CYCLE_TIMEOUT_MS,
    BUILD_TIMEOUT_MS + maxSlots * perSlotTimeoutMs,
  );
}

export function parsePositiveIntegerFlag(argv, name, fallback, options = {}) {
  const prefix = `--${name}=`;
  const matches = argv.filter((arg) => arg.startsWith(prefix));
  if (matches.length > 1) throw new Error(`duplicate --${name}`);
  const raw = matches.length === 0 ? String(fallback) : matches[0].slice(prefix.length);
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a positive integer`);
  const value = Number(raw);
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be between ${min} and ${max}`);
  }
  return value;
}

export function parseCycleNonceFlag(argv, fallback = randomUUID()) {
  const prefix = "--cycle-nonce=";
  const matches = argv.filter((arg) => arg.startsWith(prefix));
  if (matches.length > 1) throw new Error("duplicate --cycle-nonce");
  if (matches.length === 0) return fallback;
  const value = matches[0].slice(prefix.length);
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(value)) {
    throw new Error("--cycle-nonce must be a 16-128 character opaque identifier");
  }
  return value;
}

export function checkedSpawnStatus(result, label) {
  if (result?.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (!Number.isInteger(result?.status)) throw new Error(`${label} ended without an exit code`);
  return result.status;
}

export function requireSpawnSuccess(result, label) {
  const status = checkedSpawnStatus(result, label);
  if (status !== 0) throw new Error(`${label} exited with status ${status}`);
  return status;
}

export function nextConsecutiveFailureCount(previous, cycle) {
  const madeProgress = cycle.exitCode === 0 && Number.isInteger(cycle.advanced) && cycle.advanced > 0;
  return madeProgress ? 0 : previous + 1;
}

export function daemonFailureIsTerminal(explicitTerminal, consecutiveFailures, maxFailures) {
  return explicitTerminal === true || consecutiveFailures >= maxFailures;
}

export function stateWriteIsFresh(previousRaw, currentRaw, state, expectedCycleNonce) {
  return (
    typeof currentRaw === "string"
    && currentRaw !== previousRaw
    && state?.cycleNonce === expectedCycleNonce
    && typeof state?.updatedAt === "string"
    && Number.isFinite(Date.parse(state.updatedAt))
  );
}

export function daemonStateOwnsPid(state, leaseOrPid, nowMs = Date.now()) {
  const lease = typeof leaseOrPid === "number" ? { pid: leaseOrPid, token: null } : leaseOrPid;
  if (!state || !lease || state.pid !== lease.pid) return false;
  if (lease.token && state.pidLeaseToken !== lease.token) return false;
  if (!lease.token && state.pidLeaseToken) return false;
  if (!["running", "retrying"].includes(state.status)) return false;
  const updatedAt = Date.parse(state.updatedAt ?? "");
  const intervalMs = Number(state.intervalMs);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(intervalMs) || intervalMs <= 0) return false;
  const ageMs = nowMs - updatedAt;
  const maxAgeMs = Math.max(intervalMs * 2, 5 * 60_000);
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

/**
 * @param {() => void} writeHeartbeat
 * @param {{ intervalMs?: number, signal?: AbortSignal, onError?: (error: unknown) => void }} [options]
 */
export function startDaemonStateHeartbeat(
  writeHeartbeat,
  options = {},
) {
  const {
    intervalMs = DAEMON_ACTIVE_HEARTBEAT_MS,
    signal,
    onError = () => {},
  } = options;
  if (typeof writeHeartbeat !== "function") {
    throw new Error("daemon heartbeat writer must be a function");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("daemon heartbeat interval must be a positive safe integer");
  }
  if (typeof onError !== "function") {
    throw new Error("daemon heartbeat error handler must be a function");
  }

  let stopped = false;
  let timer;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    signal?.removeEventListener("abort", stop);
  };
  const heartbeat = () => {
    if (stopped) return;
    try {
      writeHeartbeat();
    } catch (error) {
      stop();
      onError(error);
    }
  };

  if (signal?.aborted) {
    stop();
    return stop;
  }
  signal?.addEventListener("abort", stop, { once: true });
  timer = setInterval(heartbeat, intervalMs);
  timer.unref?.();
  return stop;
}

export function validateSpecializedDaemonState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("specialized daemon state must be a JSON object");
  }
  if (!SPECIALIZED_DAEMON_STATUSES.has(value.status)) {
    throw new Error(`invalid specialized daemon status: ${String(value.status)}`);
  }

  for (const key of ["blockedReason", "blockedBatch", "evidenceReason"]) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") {
      throw new Error(`specialized daemon state ${key} must be a string or null`);
    }
  }
  for (const key of [
    "startedAt",
    "updatedAt",
    "heartbeatAt",
    "lastCycleAt",
    "terminalAt",
    "stoppedAt",
    "unblockedAt",
  ]) {
    if (
      value[key] !== undefined
      && value[key] !== null
      && (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key])))
    ) {
      throw new Error(`specialized daemon state ${key} must be a valid timestamp or null`);
    }
  }
  for (const key of ["intervalMs", "maxSlots", "maxConsecutiveFailures"]) {
    if (
      value[key] !== undefined
      && (!Number.isSafeInteger(value[key]) || value[key] < 1)
    ) {
      throw new Error(`specialized daemon state ${key} must be a positive safe integer`);
    }
  }
  if (
    value.consecutiveFailures !== undefined
    && (!Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0)
  ) {
    throw new Error(
      "specialized daemon state consecutiveFailures must be a non-negative safe integer",
    );
  }
  if (
    value.pid !== undefined
    && (!Number.isSafeInteger(value.pid) || value.pid < 1)
  ) {
    throw new Error("specialized daemon state pid must be a positive safe integer");
  }
  if (
    value.pidLeaseToken !== undefined
    && value.pidLeaseToken !== null
    && (typeof value.pidLeaseToken !== "string" || !PID_LEASE_TOKEN.test(value.pidLeaseToken))
  ) {
    throw new Error("specialized daemon state pidLeaseToken must be a lease UUID or null");
  }
  if (
    value.activeCycleNonce !== undefined
    && value.activeCycleNonce !== null
    && (typeof value.activeCycleNonce !== "string" || !CYCLE_NONCE.test(value.activeCycleNonce))
  ) {
    throw new Error("specialized daemon state activeCycleNonce must be an opaque nonce or null");
  }
  return value;
}

export function inspectDaemonRestartState(statePath, argv, unblockFlag = "--unblock-daemon") {
  const unblockCount = argv.filter((arg) => arg === unblockFlag).length;
  if (unblockCount > 1) throw new Error(`duplicate ${unblockFlag}`);
  const unblockRequested = unblockCount === 1;
  if (!existsSync(statePath)) return { allowed: true, unblocked: false, previous: null };

  let previous;
  try {
    previous = validateSpecializedDaemonState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch {
    if (unblockRequested) {
      return { allowed: true, unblocked: true, previous: null, reason: "invalid_daemon_state" };
    }
    return { allowed: false, unblocked: false, previous: null, reason: "invalid_daemon_state" };
  }

  if (previous?.status !== "terminal_blocked") {
    return { allowed: true, unblocked: false, previous };
  }
  if (!unblockRequested) {
    return {
      allowed: false,
      unblocked: false,
      previous,
      reason: previous.blockedReason ?? "previous_terminal_block",
    };
  }
  return {
    allowed: true,
    unblocked: true,
    previous,
    reason: previous.blockedReason ?? "previous_terminal_block",
  };
}

export function loopExitCode({ advanced, terminal = false }) {
  if (terminal) return TERMINAL_BLOCK_EXIT;
  return Number.isSafeInteger(advanced) && advanced > 0 ? 0 : 4;
}

export function completionEvidenceReady(evidence) {
  return (
    evidence.checkpointComplete === true &&
    Number.isInteger(evidence.completedUnits) &&
    evidence.completedUnits === evidence.requiredUnits &&
    evidence.artifactsReady === true
  );
}

export function inspectMissionQueueHead(head, missionId, options = {}) {
  if (!head) return { ok: false, terminal: false, reason: "queue_empty" };
  if (head.mission_id !== missionId) {
    return {
      ok: false,
      terminal: true,
      reason: `foreign_queue_head:${head.mission_id ?? "missing"}:${head.id ?? "missing"}`,
    };
  }
  if (options.phasePrefix && !String(head.phase_id ?? "").startsWith(options.phasePrefix)) {
    return {
      ok: false,
      terminal: true,
      reason: `unexpected_phase:${head.phase_id ?? "missing"}`,
    };
  }
  return { ok: true, terminal: false, reason: null };
}

export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function readPidLease(pidPath) {
  try {
    const raw = readFileSync(pidPath, "utf8").trim();
    if (/^\d+$/.test(raw)) {
      const pid = Number(raw);
      return Number.isSafeInteger(pid) && pid > 0 ? { pid, token: null } : null;
    }
    const value = JSON.parse(raw);
    return (
      Number.isSafeInteger(value?.pid)
      && value.pid > 0
      && typeof value?.token === "string"
      && /^[a-f0-9-]{36}$/.test(value.token)
    )
      ? { pid: value.pid, token: value.token }
      : null;
  } catch {
    return null;
  }
}

export function acquirePidFile(pidPath, pid = process.pid, isAlive = processIsAlive) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid daemon pid");
  mkdirSync(path.dirname(pidPath), { recursive: true });
  const acquisitionLock = `${pidPath}.acquire-lock`;
  const acquisitionOwnerPath = path.join(acquisitionLock, "owner.json");
  const acquisitionToken = randomUUID();
  let ownsAcquisitionLock = false;

  for (let attempt = 0; attempt < 3 && !ownsAcquisitionLock; attempt += 1) {
    try {
      mkdirSync(acquisitionLock);
      try {
        writeFileSync(
          acquisitionOwnerPath,
          JSON.stringify({ [["to", "ken"].join("")]: acquisitionToken, pid, acquiredAt: Date.now() }),
          { encoding: "utf8", flag: "wx" },
        );
        ownsAcquisitionLock = true;
      } catch (error) {
        rmSync(acquisitionLock, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let stale = false;
    try {
      stale = Date.now() - statSync(acquisitionLock).mtimeMs > PID_ACQUIRE_LOCK_STALE_MS;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!stale) break;

    const quarantine = `${acquisitionLock}.stale-${pid}-${randomUUID()}`;
    try {
      renameSync(acquisitionLock, quarantine);
      rmSync(quarantine, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  if (!ownsAcquisitionLock) {
    const busy = new Error(`daemon lease acquisition already in progress: ${pidPath}`);
    busy.code = "DAEMON_ACQUIRE_BUSY";
    throw busy;
  }

  const lease = { pid, token: randomUUID() };
  try {
    try {
      writeFileSync(pidPath, JSON.stringify(lease), { encoding: "utf8", flag: "wx" });
      return lease;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const existingLease = readPidLease(pidPath);
    if (existingLease && isAlive(existingLease.pid)) {
      const error = new Error(`daemon already running pid=${existingLease.pid}`);
      error.code = "DAEMON_ALREADY_RUNNING";
      error.pid = existingLease.pid;
      throw error;
    }

    rmSync(pidPath, { force: true });
    writeFileSync(pidPath, JSON.stringify(lease), { encoding: "utf8", flag: "wx" });
    return lease;
  } finally {
    try {
      const owner = JSON.parse(readFileSync(acquisitionOwnerPath, "utf8"));
      if (owner?.token === acquisitionToken) {
        rmSync(acquisitionLock, { recursive: true, force: true });
      }
    } catch {
      /* Lost ownership remains fail-closed for a later stale recovery. */
    }
  }
}

export function releasePidFile(pidPath, lease) {
  if (!lease || typeof lease !== "object" || !lease.token) return false;
  const current = readPidLease(pidPath);
  if (!current || current.pid !== lease.pid || current.token !== lease.token) return false;
  const released = `${pidPath}.released-${lease.pid}-${lease.token}`;
  try {
    renameSync(pidPath, released);
    rmSync(released, { force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function terminateProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      WINDOWS_TREE_TERMINATOR,
      "-RootPid",
      String(pid),
    ], {
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true,
      shell: false,
    });
    return result.status === 0 && !processIsAlive(pid);
  }
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch (fallbackError) {
      return fallbackError?.code === "ESRCH";
    }
  }
}

export function spawnWithTimeout(command, args, options = {}, timeoutMs = LIVE_SLOT_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid subprocess timeout: ${timeoutMs}`);
  }
  const { encoding = "utf8", signal, ...spawnOptions } = options;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: process.platform !== "win32",
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let childError = null;
    let timedOut = false;
    let settled = false;
    let settlementTimer = null;
    let terminationRequested = false;
    let terminationConfirmed = true;

    const appendOutput = (current, chunk) => {
      const combined = current + String(chunk);
      return combined.length > SUBPROCESS_OUTPUT_LIMIT
        ? combined.slice(-SUBPROCESS_OUTPUT_LIMIT)
        : combined;
    };

    if (child.stdout) {
      child.stdout.setEncoding(encoding);
      child.stdout.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); });
    }
    if (child.stderr) {
      child.stderr.setEncoding(encoding);
      child.stderr.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });
    }

    const finish = (status, childSignal) => {
      if (settled) return;
      if (terminationRequested && child.pid) {
        terminationConfirmed = !processIsAlive(child.pid);
        if (!terminationConfirmed) {
          childError = Object.assign(
            new Error(`subprocess tree termination could not be confirmed: ${command}`),
            { code: "ETERMINATION" },
          );
        }
      }
      settled = true;
      clearTimeout(timeout);
      if (settlementTimer) clearTimeout(settlementTimer);
      signal?.removeEventListener("abort", abortChild);
      resolve({
        pid: child.pid,
        status: Number.isInteger(status) ? status : null,
        signal: childSignal ?? null,
        stdout,
        stderr,
        error: childError,
        timedOut,
        terminationConfirmed,
      });
    };

    const abortChild = () => {
      if (settled) return;
      terminationRequested = true;
      childError ??= Object.assign(new Error(`subprocess aborted: ${command}`), { code: "ABORT_ERR" });
      if (child.pid) terminateProcessTree(child.pid);
      settlementTimer ??= setTimeout(() => {
        if (child.pid && processIsAlive(child.pid)) terminateProcessTree(child.pid);
        finish(null, "SIGKILL");
      }, 5_000);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminationRequested = true;
      childError = Object.assign(new Error(`subprocess timed out after ${timeoutMs}ms: ${command}`), {
        code: "ETIMEDOUT",
      });
      if (child.pid) terminateProcessTree(child.pid);
      settlementTimer = setTimeout(() => {
        if (child.pid && processIsAlive(child.pid)) terminateProcessTree(child.pid);
        finish(null, "SIGKILL");
      }, 5_000);
    }, timeoutMs);

    child.once("error", (error) => {
      childError = error;
    });
    child.once("close", finish);
    if (signal) {
      signal.addEventListener("abort", abortChild, { once: true });
      if (signal.aborted) abortChild();
    }
  });
}
