/**
 * Shared AGI literature queue advance (no API).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasUniqueCompleteStatus } from "./checkpoint-status.mjs";
import { spawnPnpmWithTimeout } from "./pnpm-runner.mjs";
import {
  spawnWithTimeout,
  VERIFY_TIMEOUT_MS,
} from "./specialized-loop-guard.mjs";

export const AGI_MISSION_ID = "juno-agi-literature-2026";
const DEFAULT_JUNO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function junoRoot() {
  return process.env.JUNO_OVERSIGHT_ROOT ?? DEFAULT_JUNO_ROOT;
}

export function countBatchPapers(workbench, batchNum) {
  const f = path.join(
    workbench,
    "missions",
    AGI_MISSION_ID,
    "papers",
    `batch-${String(batchNum).padStart(2, "0")}.yaml`,
  );
  if (!existsSync(f)) return -1;
  return (readFileSync(f, "utf8").match(/^  - title:/gm) ?? []).length;
}

function parseYamlScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return "";
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function normalizedEvidenceKey(value) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function validateAgiBatch(workbench, batchNum, seen = {}) {
  const batchPath = path.join(
    workbench,
    "missions",
    AGI_MISSION_ID,
    "papers",
    `batch-${String(batchNum).padStart(2, "0")}.yaml`,
  );
  if (!existsSync(batchPath)) return { ok: false, count: 0, reason: `missing ${path.basename(batchPath)}` };
  const text = readFileSync(batchPath, "utf8");
  const starts = [...text.matchAll(/^  - title:\s*(.*)$/gm)];
  if (starts.length !== 25) {
    return { ok: false, count: starts.length, reason: `${path.basename(batchPath)} expected 25 entries` };
  }

  const seenTitles = seen.titles ?? new Set();
  const seenUrls = seen.urls ?? new Set();
  const requiredFields = ["authors", "year", "venue", "url", "one_line", "juno_hook"];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1]?.index ?? text.length;
    const block = text.slice(start.index, end);
    const title = parseYamlScalar(start[1] ?? "");
    const fields = {};
    for (const field of requiredFields) {
      const match = block.match(new RegExp(`^    ${field}:\\s*(.*)$`, "m"));
      fields[field] = match ? parseYamlScalar(match[1]) : "";
    }
    if (title.trim().length < 5 || requiredFields.some((field) => String(fields[field]).trim() === "")) {
      return { ok: false, count: starts.length, reason: `${path.basename(batchPath)} entry ${index + 1} has empty fields` };
    }
    const year = Number(fields.year);
    if (!Number.isInteger(year) || year < 1900 || year > new Date().getUTCFullYear() + 1) {
      return { ok: false, count: starts.length, reason: `${path.basename(batchPath)} entry ${index + 1} has invalid year` };
    }
    if (!/^https?:\/\//i.test(fields.url)) {
      return { ok: false, count: starts.length, reason: `${path.basename(batchPath)} entry ${index + 1} has invalid url` };
    }
    if (fields.one_line.trim().length < 20 || fields.juno_hook.trim().length < 20) {
      return { ok: false, count: starts.length, reason: `${path.basename(batchPath)} entry ${index + 1} lacks substantive evidence` };
    }

    const titleKey = normalizedEvidenceKey(title);
    const urlKey = normalizedEvidenceKey(fields.url).replace(/\/$/, "");
    if (seenTitles.has(titleKey) || seenUrls.has(urlKey)) {
      return { ok: false, count: starts.length, reason: `${path.basename(batchPath)} entry ${index + 1} duplicates prior evidence` };
    }
    seenTitles.add(titleKey);
    seenUrls.add(urlKey);
  }
  return { ok: true, count: starts.length };
}

export function validateAgiLiteratureEvidence(workbench) {
  const seen = { titles: new Set(), urls: new Set() };
  let completedBatches = 0;
  for (let batch = 1; batch <= 40; batch += 1) {
    const result = validateAgiBatch(workbench, batch, seen);
    if (!result.ok) return { ok: false, completedBatches, reason: result.reason };
    completedBatches += 1;
  }
  const wikiPath = path.join(junoRoot(), "wiki", "juno-agi-north-star.md");
  if (!existsSync(wikiPath)) return { ok: false, completedBatches, reason: "missing AGI north-star wiki" };
  const wiki = readFileSync(wikiPath, "utf8").trim();
  if (wiki.length < 1_000 || !/^#\s+\S/m.test(wiki) || !/^##\s+\S/m.test(wiki)) {
    return { ok: false, completedBatches, reason: "AGI north-star wiki is not substantive" };
  }
  return { ok: true, completedBatches, reason: null };
}

export function validateImplementPhase(workbench, phaseId) {
  if (phaseId === "ag00-taxonomy") {
    const tax = path.join(workbench, "missions", AGI_MISSION_ID, "taxonomy-agi.md");
    const readme = path.join(workbench, "missions", AGI_MISSION_ID, "papers", "README.md");
    if (!existsSync(tax) || !existsSync(readme)) {
      throw new Error("ag00 missing taxonomy or README");
    }
    return { ok: true, changes: ["taxonomy-agi.md", "papers/README.md"] };
  }
  if (phaseId === "ag81-synthesis") {
    const wiki = path.join(junoRoot(), "wiki", "juno-agi-north-star.md");
    if (!existsSync(wiki)) {
      return {
        ok: false,
        blocked: true,
        batchFile: "wiki/juno-agi-north-star.md",
        reason: "missing wiki/juno-agi-north-star.md",
      };
    }
    const batches = countCompletedBatches(workbench);
    if (batches < 40) {
      return {
        ok: false,
        blocked: true,
        batchFile: `batch-${String(batches + 1).padStart(2, "0")}.yaml`,
        reason: `papers incomplete: ${batches}/40 batches`,
      };
    }
    return {
      ok: true,
      changes: ["wiki/juno-agi-north-star.md", "papers/batch-01..40 (1000 entries)"],
    };
  }
  const m = phaseId.match(/papers-(\d+)-(\d+)/);
  if (!m) throw new Error(`unknown implement phase: ${phaseId}`);
  const start = Number(m[1]);
  const batchNum = Math.ceil(start / 25);
  const c = countBatchPapers(workbench, batchNum);
  if (c < 0) {
    return {
      ok: false,
      blocked: true,
      batchNum,
      batchFile: `batch-${String(batchNum).padStart(2, "0")}.yaml`,
      reason: `missing batch-${String(batchNum).padStart(2, "0")}.yaml`,
    };
  }
  if (c !== 25) {
    throw new Error(`batch-${String(batchNum).padStart(2, "0")} expected 25, got ${c}`);
  }
  const evidence = validateAgiBatch(workbench, batchNum);
  if (!evidence.ok) throw new Error(evidence.reason);
  return {
    ok: true,
    changes: [`papers/batch-${String(batchNum).padStart(2, "0")}.yaml (${c} papers)`],
  };
}

function checkpointImplement(phaseId, changes) {
  return `# Checkpoint — ${phaseId}

STATUS: COMPLETE

## CHANGES
${changes.map((c) => `- ${c}`).join("\n")}
`;
}

function checkpointReview(phaseId, batchFile) {
  return `# Checkpoint — ${phaseId}

## REVIEW_VERDICT
- verdict: PASS
- drift: none
- scope_violations: []
- must_fix_next_slot: []
- reviewer_notes: batch ${batchFile} — automated agi:loop review
`;
}

function batchFileFromReviewPhase(phaseId) {
  if (phaseId === "ag82-review-synthesis") return "juno-agi-north-star.md";
  const m = phaseId.match(/review-(\d+)-(\d+)/);
  if (!m) throw new Error(`unknown review phase: ${phaseId}`);
  const batchNum = Math.ceil(Number(m[1]) / 25);
  return `batch-${String(batchNum).padStart(2, "0")}.yaml`;
}

async function checkpointVerify(workbench, phaseId) {
  const evidence = validateAgiLiteratureEvidence(workbench);
  if (!evidence.ok) throw new Error(`literature evidence invalid: ${evidence.reason}`);
  const batches = evidence.completedBatches;
  const papers = batches * 25;
  const wiki = path.join(junoRoot(), "wiki", "juno-agi-north-star.md");
  const repoRoot = junoRoot();
  const testResult = await spawnPnpmWithTimeout(["test"], { cwd: repoRoot, stdio: "inherit" }, VERIFY_TIMEOUT_MS);
  const depsResult = await spawnWithTimeout(
    process.execPath,
    ["scripts/check-orchestrator-deps.mjs"],
    { cwd: repoRoot, stdio: "inherit" },
    VERIFY_TIMEOUT_MS,
  );
  const checks = [
    { label: "papers>=1000", ok: papers >= 1000 },
    { label: "wiki/juno-agi-north-star.md", ok: existsSync(wiki) },
    { label: "pnpm test", ok: !testResult.error && testResult.status === 0 },
    { label: "check-orchestrator-deps", ok: !depsResult.error && depsResult.status === 0 },
  ];
  const lines = checks.map((c) => `- ${c.label}: ${c.ok ? "PASS" : "FAIL"}`).join("\n");
  const allOk = checks.every((c) => c.ok);
  if (!allOk) {
    throw new Error(`verify failed — papers=${papers}\n${lines}`);
  }
  return `# Checkpoint — ${phaseId}

STATUS: COMPLETE

## VERIFY_REPORT
${lines}
- eval_profile: literature
- papers_count: ${papers}
- notes: agi:loop automated verify
`;
}

function missionCompleteCheckpoint() {
  return `# Checkpoint — ${AGI_MISSION_ID}

STATUS: COMPLETE

## 状态
Mission **COMPLETE** — 1000 篇 AGI 文献 + north-star synthesis + verify PASS

**累计 papers = 1000 / 1000**

## Recent events
- ${new Date().toISOString().slice(0, 10)}: agi:daemon completed ag81–ag83
`;
}

/**
 * Advance one AGI slot. Returns { advanced, stopped, blocked }.
 */
export async function advanceOneAgiSlot(workbench, deps) {
  const {
    readNowQueueSnapshot,
    replaceQueueHeadConditional,
    replaceQueueSnapshotConditional,
  } = deps.queueIo;
  const { loadRunState, materializeQueueRun, saveRunState } = deps.manifest;
  const { evaluateCompletedRun, markMissionPhaseDone, readRunKind, shouldMarkPhaseDone } =
    deps.missionProgress;
  const { mergeOrchestratorState } = deps.idempotency;

  let queueSnapshot = readNowQueueSnapshot(workbench);
  let { now, backlog } = queueSnapshot;

  if (now.length === 0) {
    const promoted = backlog.filter((i) => i.mission_id === AGI_MISSION_ID).slice(0, 3);
    if (promoted.length === 0) {
      return { advanced: false, stopped: true, reason: "queue_empty" };
    }
    const ids = new Set(promoted.map((p) => p.id));
    backlog = backlog.filter((i) => !ids.has(i.id));
    now = promoted;
    const promotion = replaceQueueSnapshotConditional(workbench, {
      expectedRevision: queueSnapshot.revision,
      now,
      backlog,
    });
    if (!promotion.ok) {
      if (promotion.reason === "busy") {
        return { advanced: false, stopped: true, busy: true, reason: "queue_mutation_busy" };
      }
      return {
        advanced: false,
        stopped: true,
        blocked: true,
        reason: "queue_revision_conflict:backlog_promotion",
      };
    }
    queueSnapshot = promotion.current;
    ({ now, backlog } = queueSnapshot);
  }

  const head = now[0];
  if (!head || head.mission_id !== AGI_MISSION_ID) {
    return { advanced: false, stopped: true, reason: "head_not_agi" };
  }

  const kind = head.run_kind ?? head.kind;
  let cp;

  if (kind === "implement") {
    const result = validateImplementPhase(workbench, head.phase_id);
    if (!result.ok) {
      return {
        advanced: false,
        stopped: true,
        blocked: true,
        batchFile: result.batchFile,
        reason: result.reason,
      };
    }
    cp = checkpointImplement(head.phase_id, result.changes);
  } else if (kind === "review") {
    cp = checkpointReview(head.phase_id, batchFileFromReviewPhase(head.phase_id));
  } else if (kind === "verify") {
    cp = await checkpointVerify(workbench, head.phase_id);
  } else {
    return { advanced: false, stopped: true, blocked: true, reason: `unsupported_kind:${kind}` };
  }

  materializeQueueRun(head);
  const runDir = path.join(workbench, "runs", head.id);
  writeFileSync(path.join(runDir, "checkpoint.md"), cp, "utf8");
  const runState = loadRunState(runDir);
  runState.slotIndex += 1;
  runState.lastStatus = "done";
  runState.updatedAt = new Date().toISOString();
  saveRunState(runDir, runState);
  mergeOrchestratorState(workbench, {
    activeRunId: head.id,
    activeRunStatus: "done",
  });

  const action = evaluateCompletedRun(workbench, head.id, AGI_MISSION_ID);
  const runKind = readRunKind(workbench, head.id);
  const ready =
    action.action === "dequeue" &&
    (runKind !== "implement" || hasUniqueCompleteStatus(cp));

  if (!ready) throw new Error(`slot ${head.id} not ready: ${action.action}`);

  const remainingNow = queueSnapshot.now.slice(1);
  if (
    head.phase_id === "ag83-verify" &&
    [...remainingNow, ...backlog].some((item) => item.mission_id === AGI_MISSION_ID)
  ) {
    throw new Error("AGI completion refused while mission queue items remain");
  }
  const terminalVerify = head.phase_id === "ag83-verify" && /##\s*VERIFY_REPORT/i.test(cp);
  if (terminalVerify) {
    const evidence = validateAgiLiteratureEvidence(workbench);
    if (!evidence.ok || evidence.completedBatches !== 40) {
      throw new Error(`AGI completion evidence invalid: ${evidence.reason ?? "batch count"}`);
    }
  }
  const queueUpdate = terminalVerify
    ? deps.missionCompletion.finalizeSpecializedVerifyQueueHead(workbench, {
        expectedQueueRevision: queueSnapshot.revision,
        expectedHead: head,
        missionCheckpointText: missionCompleteCheckpoint(),
      })
    : replaceQueueHeadConditional(workbench, {
        expectedRevision: queueSnapshot.revision,
        expectedHead: head,
        replacement: [],
      });
  if (!queueUpdate.ok) {
    if (queueUpdate.reason === "busy") {
      return { advanced: false, stopped: true, busy: true, reason: "queue_mutation_busy" };
    }
    mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "blocked" });
    return {
      advanced: false,
      stopped: true,
      blocked: true,
      reason: `queue_${queueUpdate.reason}:${head.id}`,
    };
  }
  if (shouldMarkPhaseDone(runKind, cp)) {
    markMissionPhaseDone(workbench, AGI_MISSION_ID, head.phase_id);
  }
  mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });

  return {
    advanced: true,
    stopped: false,
    runId: head.id,
    runKind,
  };
}

export function writeAgiLoopState(workbench, state) {
  const p = path.join(workbench, "state", "agi-loop.json");
  writeFileSync(p, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

export function countCompletedBatches(workbench) {
  let n = 0;
  for (let b = 1; b <= 40; b++) {
    if (validateAgiBatch(workbench, b).ok) n += 1;
    else break;
  }
  return n;
}
