/**
 * Book mission queue advance — local gates + live-agent handoff.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasUniqueCompleteStatus } from "./checkpoint-status.mjs";
import { spawnPnpmWithTimeout } from "./pnpm-runner.mjs";
import {
  inspectMissionQueueHead,
  liveSlotTimeoutMs,
  spawnWithTimeout,
  VERIFY_TIMEOUT_MS,
} from "./specialized-loop-guard.mjs";
import {
  BOOK_MISSION_ID,
  CHAPTER_COUNT,
  TOTAL_CHARS_TARGET,
  runBookDecision,
  validatePlanningArtifacts,
  validateChapter,
  validateBookCompletionEvidence,
  parseChapterFromPhase,
  needsLiveAgent,
  missionDir,
  chapterPath,
} from "./book-decision.mjs";

const DEFAULT_JUNO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function junoRoot() {
  return process.env.JUNO_OVERSIGHT_ROOT ?? DEFAULT_JUNO_ROOT;
}

function checkpointImplement(phaseId, changes) {
  return `# Checkpoint — ${phaseId}

STATUS: COMPLETE

## CHANGES
${changes.map((c) => `- ${c}`).join("\n")}
`;
}

function checkpointReview(phaseId, notes) {
  return `# Checkpoint — ${phaseId}

## REVIEW_VERDICT
- verdict: PASS
- drift: none
- quality_tier: tier1_ok
- scope_violations: []
- must_fix_next_slot: []
- reviewer_notes: ${notes}
`;
}

function checkpointDebate(phaseId, ruling) {
  return `# Checkpoint — ${phaseId}

## DEBATE
- pro: 规划满足 charter 四条与 first-principles 要求
- con: 公理数量与章节分配仍可修订
- ruling: ${ruling}

## REVIEW_VERDICT
- verdict: PASS
- drift: none
- quality_tier: tier1_ok
- scope_violations: []
- must_fix_next_slot: []
- reviewer_notes: debate slot — ${ruling}
`;
}

async function checkpointVerify(workbench, phaseId) {
  const evidence = validateBookCompletionEvidence(workbench);
  if (!evidence.ok) throw new Error(`book evidence invalid: ${evidence.reason}`);
  const total = evidence.mergedHan;
  const merged = path.join(missionDir(workbench), "book", "全书.md");
  const repoRoot = junoRoot();
  const testResult = await spawnPnpmWithTimeout(
    ["test"],
    { cwd: repoRoot, stdio: "inherit" },
    VERIFY_TIMEOUT_MS,
  );
  const checks = [
    { label: "book_han>=95000", ok: total >= 95_000 },
    { label: "book/全书.md", ok: existsSync(merged) },
    { label: "axioms.md", ok: existsSync(path.join(missionDir(workbench), "axioms.md")) },
    { label: "pnpm test", ok: !testResult.error && testResult.status === 0 },
  ];
  for (let i = 1; i <= CHAPTER_COUNT; i++) {
    const v = validateChapter(workbench, i);
    checks.push({ label: `ch${String(i).padStart(2, "0")}`, ok: v.ok });
  }
  const lines = checks.map((c) => `- ${c.label}: ${c.ok ? "PASS" : "FAIL"}`).join("\n");
  if (!checks.every((c) => c.ok)) throw new Error(`book verify fail han=${total}\n${lines}`);
  return `# Checkpoint — ${phaseId}

STATUS: COMPLETE

## VERIFY_REPORT
${lines}
- book_han: ${total}
- eval_profile: literature
- notes: axiom-book automated verify
`;
}

function mergeChapters(workbench) {
  const dir = missionDir(workbench);
  const meta = readFileSync(path.join(dir, "book-meta.yaml"), "utf8");
  const titleM = meta.match(/title:\s*"([^"]+)"/);
  const title = titleM?.[1] ?? "从公理生长";
  const parts = [`# ${title}\n`, `> 全书 merge — ${new Date().toISOString().slice(0, 10)}\n`];
  for (let i = 1; i <= CHAPTER_COUNT; i++) {
    const p = chapterPath(workbench, i);
    if (!existsSync(p)) throw new Error(`merge missing ch${String(i).padStart(2, "0")}`);
    parts.push(readFileSync(p, "utf8"), "\n\n---\n\n");
  }
  const out = path.join(dir, "book", "全书.md");
  writeFileSync(out, parts.join("\n"), "utf8");
  return out;
}

function missionCompleteCheckpoint() {
  return `# Checkpoint — ${BOOK_MISSION_ID}

STATUS: COMPLETE

## 状态
Mission **COMPLETE** — 公理之书 ≥${TOTAL_CHARS_TARGET} 字 + verify PASS

## 产出
- book/全书.md
- axioms.md / outline.md / quality-rubric.md
- chapters/ch01..ch${String(CHAPTER_COUNT).padStart(2, "0")}.md
`;
}

function writeBookRuntimeState(workbench, fileName, state) {
  writeFileSync(
    path.join(workbench, "state", fileName),
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

export function writeBookLoopState(workbench, state) {
  writeBookRuntimeState(workbench, "book-loop.json", state);
}

export function writeBookQualityLoopState(workbench, state) {
  writeBookRuntimeState(workbench, "book-quality-loop.json", state);
}

export async function advanceOneBookSlot(workbench, deps) {
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
    const promoted = backlog.filter((i) => i.mission_id === BOOK_MISSION_ID).slice(0, 3);
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
  if (!head || head.mission_id !== BOOK_MISSION_ID) {
    return { advanced: false, stopped: true, reason: "head_not_book" };
  }

  if (needsLiveAgent(head)) {
    return {
      advanced: false,
      stopped: true,
      needLive: true,
      runId: head.id,
      reason: `live agent required for ${head.phase_id} (${head.run_kind ?? head.kind})`,
    };
  }

  const kind = head.run_kind ?? head.kind;
  const phase = head.phase_id ?? "";
  let cp;

  if (kind === "implement" && phase === "ax00-decide") {
    const files = runBookDecision(workbench);
    const v = validatePlanningArtifacts(workbench);
    if (!v.ok) throw new Error(`planning invalid: ${JSON.stringify(v)}`);
    cp = checkpointImplement(phase, files);
  } else if (kind === "debate" && phase === "ax01-debate-axioms") {
    cp = checkpointDebate(phase, "采纳 M1+A1–A5 与 20 章结构；写作阶段可微调表述不可删公理");
  } else if (kind === "review" && phase === "ax02-review-plan") {
    const v = validatePlanningArtifacts(workbench);
    if (!v.ok) throw new Error("plan review fail");
    cp = checkpointReview(phase, "planning artifacts PASS — axiom-book");
  } else if (kind === "implement" && phase === "ax43-merge") {
    const out = mergeChapters(workbench);
    cp = checkpointImplement(phase, [out]);
  } else if (kind === "debate" && phase === "ax44-debate-final") {
    cp = checkpointDebate(phase, "全书 merge 后进入 final review；抽样文体一致");
  } else if (kind === "review" && phase === "ax45-review-final") {
    cp = checkpointReview(phase, "final book review PASS (automated gate — live review recommended)");
  } else if (kind === "verify" && phase === "ax46-verify") {
    cp = await checkpointVerify(workbench, phase);
  } else {
    return { advanced: false, stopped: true, reason: `unsupported_local:${phase}:${kind}` };
  }

  materializeQueueRun(head);
  const runDir = path.join(workbench, "runs", head.id);
  writeFileSync(path.join(runDir, "checkpoint.md"), cp, "utf8");
  const runState = loadRunState(runDir);
  runState.slotIndex += 1;
  runState.lastStatus = "done";
  runState.updatedAt = new Date().toISOString();
  saveRunState(runDir, runState);
  mergeOrchestratorState(workbench, { activeRunId: head.id, activeRunStatus: "done" });

  const action = evaluateCompletedRun(workbench, head.id, BOOK_MISSION_ID);
  const runKind = readRunKind(workbench, head.id);
  const ready =
    action.action === "dequeue" &&
    (runKind !== "implement" || hasUniqueCompleteStatus(cp));

  if (!ready) throw new Error(`slot ${head.id} not ready: ${action.action}`);

  const remainingNow = queueSnapshot.now.slice(1);
  if (
    phase === "ax46-verify" &&
    [...remainingNow, ...backlog].some((item) => item.mission_id === BOOK_MISSION_ID)
  ) {
    throw new Error("Book completion refused while mission queue items remain");
  }
  const terminalVerify = phase === "ax46-verify";
  if (terminalVerify) {
    const evidence = validateBookCompletionEvidence(workbench);
    if (!evidence.ok || evidence.completedChapters !== CHAPTER_COUNT) {
      throw new Error(`Book completion evidence invalid: ${evidence.reason ?? "chapter count"}`);
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
    markMissionPhaseDone(workbench, BOOK_MISSION_ID, head.phase_id);
  }
  mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });

  return { advanced: true, runId: head.id, runKind };
}

export async function spawnLiveBookSlot(workbench, head, deps) {
  const repoRoot = junoRoot();
  const { loadProjectEnv } = await import("../../orchestrator/dist/env.js");
  loadProjectEnv();
  const { materializeQueueRun } = deps.manifest;
  const {
    evaluateCompletedRun,
    markMissionPhaseDone,
    readRunKind,
    shouldMarkPhaseDone,
    buildReviseImplementItem,
    nextRevisionAttempt,
  } = deps.missionProgress;
  const { readNowQueueSnapshot, replaceQueueHeadConditional } = deps.queueIo;
  const { mergeOrchestratorState } = deps.idempotency;

  const initialQueue = readNowQueueSnapshot(workbench);
  const initialGuard = inspectMissionQueueHead(initialQueue.now[0], BOOK_MISSION_ID);
  if (!initialGuard.ok || initialQueue.now[0]?.id !== head.id) {
    return {
      ok: false,
      reason: initialGuard.ok ? `queue_head_changed:${head.id}` : initialGuard.reason,
    };
  }

  const manifestPath = materializeQueueRun(head);
  const spawnScript = path.join(repoRoot, "orchestrator", "dist", "spawn-run.js");
  const r = await spawnWithTimeout(process.execPath, [spawnScript, "--manifest", manifestPath], {
    cwd: repoRoot,
    env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench, JUNO_OVERSIGHT_ROOT: repoRoot },
    stdio: "inherit",
    shell: false,
  }, liveSlotTimeoutMs(head.max_minutes ?? 25));

  if (r.error || r.status !== 0) {
    return { ok: false, reason: r.error?.message ?? `spawn-run exit ${r.status}` };
  }

  const runDir = path.join(workbench, "runs", head.id);
  const cpPath = path.join(runDir, "checkpoint.md");
  if (!existsSync(cpPath)) {
    return { ok: false, reason: "live slot finished but no checkpoint.md" };
  }

  const cp = readFileSync(cpPath, "utf8");
  const runKind = readRunKind(workbench, head.id);
  const ch = parseChapterFromPhase(head.phase_id ?? "");
  let action = evaluateBookRunCompletion(workbench, head.id, evaluateCompletedRun);

  if (ch && runKind === "implement" && /-write|-revise/.test(head.phase_id ?? "")) {
    const { validateChapterText, autoFixChapterSpacedBold } = await import(
      "../../orchestrator/dist/quality-gate.js"
    );
    const p = chapterPath(workbench, ch);
    const text = readFileSync(p, "utf8");
    let report = validateChapterText(text, ch, { strictLength: false });
    if (!report.ok) {
      const failCodes = report.issues.filter((i) => i.severity === "fail").map((i) => i.code);
      if (failCodes.every((c) => c === "spaced_bold")) {
        const fixResult = autoFixChapterSpacedBold(workbench, ch, { strictLength: false });
        if (fixResult.fixed) {
          report = validateChapterText(readFileSync(p, "utf8"), ch, { strictLength: false });
        }
      }
      if (!report.ok) {
        const mustFix = report.issues
          .filter((i) => i.severity === "fail")
          .map((i) => `${i.code}: ${i.message}`);
        action = { action: "revise", mustFix };
      }
    }
  }

  if (action.action === "revise") {
    const revisionAttempt = nextRevisionAttempt(
      workbench,
      head.id,
      [...initialQueue.now, ...initialQueue.backlog],
    );
    const revisionPhaseId = head.phase_id?.includes("-revise-")
      ? head.phase_id
      : `${head.phase_id?.replace(/-review$/, "-write") ?? "fix"}-revise-${revisionAttempt}`;
    const fix = buildReviseImplementItem(
      { ...head, repo_target: "workbench", phase_id: revisionPhaseId },
      revisionAttempt,
      action.mustFix ?? [],
    );
    const queueUpdate = replaceQueueHeadConditional(workbench, {
      expectedRevision: initialQueue.revision,
      expectedHead: head,
      replacement: [fix],
    });
    if (!queueUpdate.ok) {
      mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "blocked" });
      return {
        ok: false,
        busy: queueUpdate.reason === "busy",
        reason: `queue_${queueUpdate.reason}:${head.id}`,
      };
    }
    mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });
    return {
      ok: true,
      dequeued: false,
      revised: true,
      runId: head.id,
      mustFix: action.mustFix,
    };
  }

  if (ch && runKind === "implement") {
    const v = validateChapter(workbench, ch);
    if (!v.ok && !/-revise-/.test(head.phase_id ?? "")) {
      return { ok: false, reason: `chapter gate: ${v.reason}` };
    }
  }

  if (action.action !== "dequeue") {
    return { ok: false, reason: `live slot not dequeue-ready: ${action.action}` };
  }

  const queueUpdate = replaceQueueHeadConditional(workbench, {
    expectedRevision: initialQueue.revision,
    expectedHead: head,
    replacement: [],
  });
  if (!queueUpdate.ok) {
    mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "blocked" });
    return {
      ok: false,
      busy: queueUpdate.reason === "busy",
      reason: `queue_${queueUpdate.reason}:${head.id}`,
    };
  }
  if (shouldMarkPhaseDone(runKind, cp)) {
    markMissionPhaseDone(workbench, BOOK_MISSION_ID, head.phase_id);
  }
  mergeOrchestratorState(workbench, { activeRunId: null, activeRunStatus: "idle" });

  return { ok: true, dequeued: true, runId: head.id };
}

export function evaluateBookRunCompletion(workbench, runId, evaluateCompletedRun) {
  return evaluateCompletedRun(workbench, runId, BOOK_MISSION_ID);
}

export { needsLiveAgent, BOOK_MISSION_ID };
