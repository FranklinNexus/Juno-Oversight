import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function unquote(value) {
  const trimmed = String(value ?? "").trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function parseMissionYaml(text) {
  const phases = [];
  let missionStatus = null;
  let inPhases = false;
  let current = null;

  for (const line of String(text ?? "").split(/\r?\n/)) {
    const topStatus = line.match(/^status:\s*(.+)$/);
    if (topStatus) {
      missionStatus = unquote(topStatus[1]).toUpperCase();
      continue;
    }
    if (/^phases:\s*$/.test(line)) {
      inPhases = true;
      continue;
    }
    if (!inPhases) continue;

    const phaseId = line.match(/^\s{2}-\s+id:\s*(.+)$/);
    if (phaseId) {
      current = { id: unquote(phaseId[1]), status: "unknown" };
      phases.push(current);
      continue;
    }
    const phaseStatus = line.match(/^\s{4}status:\s*(.+)$/);
    if (current && phaseStatus) {
      current.status = unquote(phaseStatus[1]).toLowerCase();
    }
  }

  return { missionStatus, phases };
}

export function parseQueueYaml(text) {
  const sections = { now: [], backlog: [] };
  let section = "now";
  let current = null;

  const flush = () => {
    if (current?.id) sections[section].push(current);
    current = null;
  };

  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (/^now:\s*$/.test(line)) {
      flush();
      section = "now";
      continue;
    }
    if (/^backlog:\s*$/.test(line)) {
      flush();
      section = "backlog";
      continue;
    }
    const itemId = line.match(/^\s{2}-\s+id:\s*(.+)$/);
    if (itemId) {
      flush();
      current = { id: unquote(itemId[1]), missionId: null, phaseId: null };
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s{4}(mission_id|phase_id):\s*(.+)$/);
    if (!field) continue;
    if (field[1] === "mission_id") current.missionId = unquote(field[2]);
    if (field[1] === "phase_id") current.phaseId = unquote(field[2]);
  }
  flush();
  return sections;
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLivePid(file, pidChecker) {
  const pid = Number(readText(file).trim());
  return Number.isInteger(pid) && pid > 0 && pidChecker(pid) ? pid : null;
}

function inferReviewGate(phase, checkpoint) {
  if (!phase) return "NOT_CONFIGURED";
  if (/verdict:\s*BLOCK/i.test(checkpoint)) return "BLOCK";
  if (/verdict:\s*REVISE/i.test(checkpoint)) return "REVISE";
  if (/verdict:\s*PASS/i.test(checkpoint)) return "PASS";
  return phase.status === "done" ? "PASS" : "PENDING";
}

function inferVerifyGate(phase, checkpoint) {
  if (!phase) return "NOT_CONFIGURED";
  if (/verdict:\s*BLOCK/i.test(checkpoint)) return "BLOCK";
  if (/##\s*VERIFY_REPORT[\s\S]*?\*\*FAIL\*\*/i.test(checkpoint)) return "FAIL";
  if (/##\s*VERIFY_REPORT/i.test(checkpoint) && phase.status === "done") return "PASS";
  return phase.status === "done" ? "PASS" : "PENDING";
}

function checkpointForPhase(workbench, missionId, phaseId) {
  const directRun = path.join(workbench, "runs", `${missionId}-${phaseId}`);
  const directCheckpoint = path.join(directRun, "checkpoint.md");
  if (existsSync(directCheckpoint)) return readText(directCheckpoint);

  const runsRoot = path.join(workbench, "runs");
  if (!existsSync(runsRoot)) return "";
  let candidates = [];
  try {
    candidates = readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${missionId}-${phaseId}`))
      .map((entry) => {
        const checkpoint = path.join(runsRoot, entry.name, "checkpoint.md");
        return {
          checkpoint,
          modified: existsSync(checkpoint) ? statSync(checkpoint).mtimeMs : 0,
        };
      })
      .sort((a, b) => b.modified - a.modified);
  } catch {
    return "";
  }
  return candidates[0] ? readText(candidates[0].checkpoint) : "";
}

export function latestMissionId(workbench) {
  const plan = readJson(path.join(workbench, "state", "last-brief-plan.json"), null);
  return plan?.missionId ?? null;
}

export function readControlSnapshot(workbench, requestedMissionId = null, options = {}) {
  const pidChecker = options.pidChecker ?? isProcessAlive;
  const missionId = requestedMissionId ?? latestMissionId(workbench);
  const orchestrator = readJson(path.join(workbench, "state", "orchestrator.json"));
  const scheduler = readJson(path.join(workbench, "state", "scheduler.json"));
  const queue = parseQueueYaml(readText(path.join(workbench, "queue", "now.yaml")));
  const schedulerPid = readLivePid(
    path.join(workbench, "state", "daemon.pid"),
    pidChecker,
  );

  let missionStatus = null;
  let phases = [];
  let missionExists = false;
  if (missionId) {
    const missionPath = path.join(workbench, "missions", missionId, "mission.yaml");
    missionExists = existsSync(missionPath);
    if (missionExists) {
      const parsed = parseMissionYaml(readText(missionPath));
      missionStatus = parsed.missionStatus;
      phases = parsed.phases;
    }
  }

  const phaseDone = phases.filter((phase) => phase.status === "done").length;
  const currentPhase = phases.find((phase) => phase.status !== "done") ?? null;
  const activeRunId = orchestrator.activeRunId ?? null;
  const activeRunStatus = String(orchestrator.activeRunStatus ?? "idle").toLowerCase();
  const activeRunBelongsToMission = Boolean(
    missionId && activeRunId && activeRunId.startsWith(`${missionId}-`),
  );
  const activeRunState = activeRunId
    ? readJson(path.join(workbench, "runs", activeRunId, "run-state.json"), null)
    : null;
  const workerPid = Number(orchestrator.activeWorkerPid);
  const liveWorkerPid = Number.isInteger(workerPid) && pidChecker(workerPid) ? workerPid : null;
  const reviewPhase = phases.find((phase) => /review/i.test(phase.id));
  const verifyPhase = phases.find((phase) => /verify/i.test(phase.id));
  const reviewCheckpoint = reviewPhase && missionId
    ? checkpointForPhase(workbench, missionId, reviewPhase.id)
    : "";
  const verifyCheckpoint = verifyPhase && missionId
    ? checkpointForPhase(workbench, missionId, verifyPhase.id)
    : "";
  const missionQueueDepth = missionId
    ? [...queue.now, ...queue.backlog].filter((item) => item.missionId === missionId).length
    : 0;
  const complete =
    missionExists &&
    missionStatus === "COMPLETE" &&
    phases.length > 0 &&
    phaseDone === phases.length;
  const blocked =
    !complete &&
    (missionStatus === "BLOCKED" ||
      (activeRunBelongsToMission && activeRunStatus === "blocked"));
  const retryExhausted =
    Number.isInteger(activeRunState?.retryCount) &&
    Number.isInteger(activeRunState?.maxRetries) &&
    activeRunState.retryCount >= activeRunState.maxRetries;
  const failed =
    !complete &&
    !blocked &&
    (missionStatus === "FAILED" ||
      (activeRunBelongsToMission &&
        ["failed", "stall"].includes(activeRunStatus) &&
        (retryExhausted || schedulerPid === null)));

  return {
    timestamp: new Date().toISOString(),
    workbench,
    missionId,
    missionExists,
    missionStatus: missionExists ? missionStatus : missionId ? "MISSING" : null,
    phaseDone,
    phaseTotal: phases.length,
    currentPhaseId: currentPhase?.id ?? null,
    phases,
    gates: {
      review: inferReviewGate(reviewPhase, reviewCheckpoint),
      verify: inferVerifyGate(verifyPhase, verifyCheckpoint),
    },
    complete,
    blocked,
    failed,
    retryExhausted,
    queueDepth: queue.now.length,
    backlogDepth: queue.backlog.length,
    missionQueueDepth,
    activeRunId,
    activeRunStatus,
    activeRunBelongsToMission,
    activeRunState,
    schedulerEnabled: scheduler.enabled !== false,
    schedulerRunning: schedulerPid !== null,
    schedulerPid,
    workerPid: liveWorkerPid,
    workerRunning:
      liveWorkerPid !== null || (activeRunBelongsToMission && activeRunStatus === "running"),
    schedulerLastAction: scheduler.lastAction ?? null,
    schedulerLastTickAt: scheduler.lastTickAt ?? null,
  };
}

export function classifyMissionSnapshot(snapshot) {
  if (snapshot.complete) return "complete";
  if (!snapshot.missionExists) return "missing";
  if (snapshot.blocked) return "blocked";
  if (snapshot.failed) return "failed";
  return "running";
}

export async function waitForMission(options) {
  const {
    workbench,
    missionId,
    timeoutMs = 30 * 60_000,
    pollMs = 2_000,
    onProgress = () => {},
    snapshotReader = readControlSnapshot,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = options;
  const startedAt = now();

  while (true) {
    const snapshot = snapshotReader(workbench, missionId);
    const outcome = classifyMissionSnapshot(snapshot);
    onProgress(snapshot, outcome);
    if (["complete", "missing", "blocked", "failed"].includes(outcome)) {
      return { outcome, timedOut: false, durationMs: now() - startedAt, snapshot };
    }
    if (now() - startedAt >= timeoutMs) {
      return { outcome: "timeout", timedOut: true, durationMs: now() - startedAt, snapshot };
    }
    await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (now() - startedAt))));
  }
}
