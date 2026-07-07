/**
 * Vault bridge core — Obsidian inbox + execution log ↔ Workbench runtime.
 * Phase A: Status board, escalations, brief auto-ingest, missionId binding.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const STALE_RUNNING_MS = 6 * 60 * 60 * 1000;

export function nowIso() {
  return new Date().toISOString();
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function readWorkbenchConfig(workbench) {
  const cfgPath = path.join(workbench, "config.yaml");
  if (!existsSync(cfgPath)) return null;
  const raw = readFileSync(cfgPath, "utf8");
  const vaultMatch = raw.match(/vault_path:\s*["']?([^"'\n]+)/i);
  const rootMatch = raw.match(/vault_juno_root:\s*["']?([^"'\n]+)/i);
  if (!vaultMatch?.[1]) return null;
  const vaultPath = vaultMatch[1].trim().replace(/\\\\/g, "\\");
  const vaultJunoRoot = (rootMatch?.[1] ?? "Juno").trim();
  return { vaultPath, vaultJunoRoot };
}

export function bridgePaths(workbench) {
  const cfg = readWorkbenchConfig(workbench);
  if (!cfg) return null;
  const junoRoot = path.join(cfg.vaultPath, cfg.vaultJunoRoot);
  return {
    junoRoot,
    missionFile: path.join(junoRoot, "Juno_Mission_Inbox.md"),
    logFile: path.join(junoRoot, "Juno_Execution_Log.md"),
    statusFile: path.join(junoRoot, "Juno_Status.md"),
    escalationsFile: path.join(junoRoot, "Human_Escalations.md"),
    briefFile: path.join(junoRoot, "inbox", "brief.md"),
    stateFile: path.join(workbench, "state", "vault-bridge-state.json"),
  };
}

export function ensureTemplateFiles(paths) {
  mkdirSync(path.dirname(paths.missionFile), { recursive: true });
  mkdirSync(path.dirname(paths.logFile), { recursive: true });
  mkdirSync(path.dirname(paths.briefFile), { recursive: true });
  mkdirSync(path.dirname(paths.stateFile), { recursive: true });

  if (!existsSync(paths.missionFile)) {
    writeFileSync(
      paths.missionFile,
      [
        "# Juno Mission Inbox",
        "",
        "> 写 `- [ ] mission`；Juno 摄入后变 `- [/]`（执行中），verify PASS 后变 `- [x]`。",
        "",
        "## Missions",
        "",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  if (!existsSync(paths.logFile)) {
    writeFileSync(
      paths.logFile,
      [
        "# Juno Execution Log",
        "",
        "> Juno 自动写入：摄入、implement/review/verify、push、日摘要。",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  if (!existsSync(paths.statusFile)) {
    writeFileSync(
      paths.statusFile,
      [
        "# Juno Status",
        "",
        "> 当前态看板（机器维护）。历史见 [[Juno_Execution_Log]]。",
        "",
        "_等待首次同步…_",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  if (!existsSync(paths.escalationsFile)) {
    writeFileSync(
      paths.escalationsFile,
      [
        "# Human Escalations",
        "",
        "> Juno 无法自治推进时写入此处。处理完后可手动删除对应条目。",
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

export function loadState(stateFile) {
  if (!existsSync(stateFile)) {
    return {
      byHash: {},
      byMissionId: {},
      dailyHeartbeat: {},
      dailySummary: {},
      briefIngest: {},
      constitutionAlert: {},
      escalations: {},
    };
  }
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8"));
    return {
      byHash: s.byHash ?? s.processed ?? {},
      byMissionId: s.byMissionId ?? {},
      dailyHeartbeat: s.dailyHeartbeat ?? {},
      dailySummary: s.dailySummary ?? {},
      briefIngest: s.briefIngest ?? {},
      constitutionAlert: s.constitutionAlert ?? {},
      escalations: s.escalations ?? {},
    };
  } catch {
    return {
      byHash: {},
      byMissionId: {},
      dailyHeartbeat: {},
      dailySummary: {},
      briefIngest: {},
      constitutionAlert: {},
      escalations: {},
    };
  }
}

export function saveState(stateFile, state) {
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function missionHash(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

export function parseInboxLines(markdown) {
  const lines = markdown.split(/\r?\n/);
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*\[(.)\]\s+(.+?)\s*$/);
    if (!m?.[2]) continue;
    const mark = m[1];
    const text = m[2].replace(/\s*<!--\s*juno:[^>]+-->\s*$/, "").trim();
    const tag = lines[i].match(/<!--\s*juno:([a-f0-9]{12})(?:\s+\w+)?\s*-->/i);
    const checked = /x/i.test(mark);
    const inProgress = mark === "/";
    items.push({
      lineIndex: i,
      raw: lines[i],
      text,
      hash: tag?.[1] ?? missionHash(text),
      checked,
      inProgress,
      pending: mark === " " && !checked,
    });
  }
  return { lines, items };
}

function upsertDailySection(md, date) {
  const heading = `## ${date}`;
  if (md.includes(`\n${heading}\n`) || md.startsWith(`${heading}\n`)) {
    return md;
  }
  const suffix = md.endsWith("\n") ? "" : "\n";
  return `${md}${suffix}\n${heading}\n\n`;
}

export function appendLogEntry(logFile, date, entry) {
  if (!existsSync(logFile)) return;
  const logMd = readFileSync(logFile, "utf8");
  const withSection = upsertDailySection(logMd, date);
  const marker = `## ${date}\n`;
  const idx = withSection.indexOf(marker);
  if (idx < 0) return;
  const insertAt = idx + marker.length;
  const updated = `${withSection.slice(0, insertAt)}\n- ${entry}\n${withSection.slice(insertAt)}`;
  writeFileSync(logFile, updated, "utf8");
}

function escalationKey(kind, reason, missionId) {
  return missionHash(`${kind}|${reason}|${missionId ?? ""}|${today()}`);
}

export function recordEscalation(workbench, opts) {
  const paths = bridgePaths(workbench);
  if (!paths) return false;
  ensureTemplateFiles(paths);

  const { kind, reason, detail, missionId, runId, checkpointPath } = opts;
  const state = loadState(paths.stateFile);
  const key = escalationKey(kind, reason, missionId);
  if (state.escalations?.[key]) return false;

  const date = today();
  const parts = [
    `${nowIso()} 🚨 **${kind}**`,
    missionId ? `mission \`${missionId}\`` : null,
    runId ? `run \`${runId}\`` : null,
    `— ${reason}`,
    detail ? `(${detail})` : null,
    checkpointPath ? `→ \`${checkpointPath}\`` : null,
  ].filter(Boolean);

  let escMd = existsSync(paths.escalationsFile)
    ? readFileSync(paths.escalationsFile, "utf8")
    : "# Human Escalations\n\n";
  escMd = upsertDailySection(escMd, date);
  const marker = `## ${date}\n`;
  const idx = escMd.indexOf(marker);
  if (idx >= 0) {
    const insertAt = idx + marker.length;
    escMd = `${escMd.slice(0, insertAt)}\n- ${parts.join(" ")}\n${escMd.slice(insertAt)}`;
  } else {
    escMd += `\n- ${parts.join(" ")}\n`;
  }
  writeFileSync(paths.escalationsFile, escMd, "utf8");

  appendLogEntry(paths.logFile, date, parts.join(" "));

  state.escalations = { ...(state.escalations ?? {}), [key]: nowIso() };
  saveState(paths.stateFile, state);
  return true;
}

function readLastBriefPlan(workbench) {
  const planPath = path.join(workbench, "state", "last-brief-plan.json");
  if (!existsSync(planPath)) return null;
  try {
    return JSON.parse(readFileSync(planPath, "utf8"));
  } catch {
    return null;
  }
}

export function resolveMissionId(workbench, sourceText, fallback) {
  if (fallback && !String(fallback).startsWith("unknown-")) return fallback;

  const plan = readLastBriefPlan(workbench);
  if (plan?.missionId) {
    const planText = plan.sourceText ?? plan.text ?? "";
    if (!planText || missionHash(planText) === missionHash(sourceText)) {
      return plan.missionId;
    }
  }

  return fallback ?? `unknown-${missionHash(sourceText)}`;
}

function parseBriefMissionId(stdout, workbench, sourceText) {
  const text = stdout.trim();
  if (text) {
    for (const line of text.split("\n").reverse()) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const j = JSON.parse(t);
        if (j.missionId) return resolveMissionId(workbench, sourceText, j.missionId);
        if (j.plan?.missionId) return resolveMissionId(workbench, sourceText, j.plan.missionId);
      } catch {
        /* continue */
      }
    }
  }
  return resolveMissionId(workbench, sourceText, null);
}

function runBrief(repoRoot, workbench, missionText, filePath) {
  const args = ["scripts/juno-brief.mjs", "--execute"];
  if (filePath) {
    args.push("--file", filePath);
  } else {
    args.push(missionText);
  }
  const r = spawnSync("node", args, {
    cwd: repoRoot,
    stdio: "pipe",
    shell: false,
    env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench, JUNO_OVERSIGHT_ROOT: repoRoot },
    encoding: "utf8",
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return {
    ok: (r.status ?? 1) === 0,
    status: r.status ?? 1,
    output,
    missionId: parseBriefMissionId(r.stdout ?? "", workbench, missionText),
  };
}

function markInboxRunning(lines, item, hash, missionId) {
  const base = item.text;
  lines[item.lineIndex] = `- [/] ${base} <!-- juno:${hash} mission:${missionId} -->`;
}

function readOrchestratorSnapshot(workbench) {
  const p = path.join(workbench, "state", "orchestrator.json");
  if (!existsSync(p)) return { activeRunId: null, activeRunStatus: "idle" };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { activeRunId: null, activeRunStatus: "idle" };
  }
}

function readAutonomySnapshot(workbench) {
  const p = path.join(workbench, "state", "bounded-autonomy.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function parseQueueHead(workbench) {
  const file = path.join(workbench, "queue/now.yaml");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  if (/now:\s*\[\]/.test(text)) return null;
  const nowMatch = text.match(/now:\s*\n([\s\S]*?)(?:\nbacklog:|$)/);
  if (!nowMatch?.[1]?.trim()) return null;
  const block = nowMatch[1];
  const clean = (v) => v?.replace(/^["']|["']$/g, "") ?? null;
  return {
    id: clean(block.match(/^\s*-\s*id:\s*(\S+)/m)?.[1]),
    mission_id: clean(block.match(/mission_id:\s*(\S+)/)?.[1]),
    phase_id: clean(block.match(/phase_id:\s*(\S+)/)?.[1]),
    run_kind: clean(block.match(/run_kind:\s*(\S+)/)?.[1]),
  };
}

function missionInQueue(workbench, missionId) {
  const file = path.join(workbench, "queue/now.yaml");
  if (!existsSync(file) || !missionId) return false;
  return readFileSync(file, "utf8").includes(`mission_id: ${missionId}`);
}

export function reconcileStaleInProgress(workbench, paths, state) {
  if (!existsSync(paths.missionFile)) return { fixed: 0 };
  const missionMd = readFileSync(paths.missionFile, "utf8");
  const { lines, items } = parseInboxLines(missionMd);
  const orch = readOrchestratorSnapshot(workbench);
  let fixed = 0;
  let changed = false;

  for (const item of items) {
    if (item.checked && state.byHash?.[item.hash]?.status !== "done") {
      if (state.byHash?.[item.hash]) {
        state.byHash[item.hash].status = "done";
        state.byHash[item.hash].completedAt = state.byHash[item.hash].completedAt ?? nowIso();
        fixed += 1;
      }
      continue;
    }

    if (!item.inProgress) continue;
    const track = state.byHash?.[item.hash];

    if (track?.status === "done") {
      lines[item.lineIndex] = `- [x] ${item.text} <!-- juno:${item.hash} done -->`;
      changed = true;
      fixed += 1;
      continue;
    }

    if (!track) {
      lines[item.lineIndex] = `- [ ] ${item.text}`;
      changed = true;
      fixed += 1;
      continue;
    }

    if (track.missionId?.startsWith("unknown-")) {
      const resolved = resolveMissionId(workbench, item.text, track.missionId);
      if (resolved && !resolved.startsWith("unknown-")) {
        track.missionId = resolved;
        state.byMissionId = { ...(state.byMissionId ?? {}), [resolved]: { hash: item.hash, text: item.text } };
        lines[item.lineIndex] = `- [/] ${item.text} <!-- juno:${item.hash} mission:${resolved} -->`;
        changed = true;
        fixed += 1;
      }
    }

    const queuedAt = track.queuedAt ? Date.parse(track.queuedAt) : 0;
    const stale =
      queuedAt > 0 &&
      Date.now() - queuedAt > STALE_RUNNING_MS &&
      orch.activeRunStatus !== "running" &&
      !missionInQueue(workbench, track.missionId);

    if (stale && track.status === "running") {
      delete state.byHash[item.hash];
      if (track.missionId) delete state.byMissionId[track.missionId];
      lines[item.lineIndex] = `- [ ] ${item.text}`;
      appendLogEntry(
        paths.logFile,
        today(),
        `${nowIso()} 🔁 重置 stale [/] → [ ]：${item.text.slice(0, 100)}（mission 未在队列中）`,
      );
      changed = true;
      fixed += 1;
    }
  }

  if (changed) writeFileSync(paths.missionFile, `${lines.join("\n")}\n`, "utf8");
  return { fixed, state };
}

export function syncInboxIngest(workbench, repoRoot) {
  const paths = bridgePaths(workbench);
  if (!paths) return { ingested: 0 };
  ensureTemplateFiles(paths);

  let state = loadState(paths.stateFile);
  const date = today();

  if (state.dailyHeartbeat?.[date] !== true) {
    appendLogEntry(paths.logFile, date, `${nowIso()} 心跳：Juno 在线，等待/执行 missions。`);
    state.dailyHeartbeat = { ...(state.dailyHeartbeat ?? {}), [date]: true };
  }

  const recon = reconcileStaleInProgress(workbench, paths, state);
  state = recon.state ?? state;

  const missionMd = readFileSync(paths.missionFile, "utf8");
  const { lines, items } = parseInboxLines(missionMd);
  let ingested = 0;
  let changed = recon.fixed > 0;

  for (const item of items) {
    if (!item.pending) continue;

    const res = runBrief(repoRoot, workbench, item.text);
    if (!res.ok) {
      appendLogEntry(
        paths.logFile,
        date,
        `${nowIso()} ❌ 摄入失败：${item.text.slice(0, 120)}（exit=${res.status}）`,
      );
      recordEscalation(workbench, {
        kind: "ingest_fail",
        reason: `brief exit=${res.status}`,
        detail: item.text.slice(0, 80),
      });
      continue;
    }

    const missionId = resolveMissionId(workbench, item.text, res.missionId);
    markInboxRunning(lines, item, item.hash, missionId);
    state.byHash = {
      ...(state.byHash ?? {}),
      [item.hash]: {
        text: item.text,
        missionId,
        queuedAt: nowIso(),
        status: "running",
      },
    };
    state.byMissionId = {
      ...(state.byMissionId ?? {}),
      [missionId]: { hash: item.hash, text: item.text },
    };
    appendLogEntry(
      paths.logFile,
      date,
      `${nowIso()} 📥 已摄入 → \`${missionId}\`：${item.text.slice(0, 160)}`,
    );
    ingested += 1;
    changed = true;
  }

  if (changed) writeFileSync(paths.missionFile, `${lines.join("\n")}\n`, "utf8");
  saveState(paths.stateFile, state);
  return { ingested };
}

export function extractBriefBody(markdown) {
  const withoutTag = markdown.replace(/\s*<!--\s*juno:ingested[^>]+-->\s*$/i, "").trim();
  const parts = withoutTag.split(/^---\s*$/m);
  if (parts.length >= 2) {
    return parts[parts.length - 1].trim();
  }
  const lines = withoutTag.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes("在下方写你的任务"));
  if (start >= 0) return lines.slice(start + 1).join("\n").trim();
  return withoutTag.trim();
}

export function syncBriefIngest(workbench, repoRoot) {
  const paths = bridgePaths(workbench);
  if (!paths || !existsSync(paths.briefFile)) return { ingested: false };

  const raw = readFileSync(paths.briefFile, "utf8");
  const body = extractBriefBody(raw);
  if (!body || body.length < 8) return { ingested: false };

  const hash = missionHash(body);
  const state = loadState(paths.stateFile);
  if (state.briefIngest?.hash === hash) return { ingested: false };

  const res = runBrief(repoRoot, workbench, body, paths.briefFile);
  const date = today();
  if (!res.ok) {
    appendLogEntry(paths.logFile, date, `${nowIso()} ❌ brief.md 摄入失败（exit=${res.status}）`);
    recordEscalation(workbench, {
      kind: "brief_ingest_fail",
      reason: `exit=${res.status}`,
      detail: body.slice(0, 80),
    });
    return { ingested: false };
  }

  const missionId = resolveMissionId(workbench, body, res.missionId);
  const tag = `<!-- juno:ingested ${hash} mission:${missionId} -->`;
  const updated = raw.replace(/\s*<!--\s*juno:ingested[^>]+-->\s*$/i, "").trimEnd();
  writeFileSync(paths.briefFile, `${updated}\n\n${tag}\n`, "utf8");

  state.briefIngest = { hash, missionId, ingestedAt: nowIso() };
  saveState(paths.stateFile, state);

  appendLogEntry(paths.logFile, date, `${nowIso()} 📥 brief.md 已摄入 → \`${missionId}\``);
  return { ingested: true, missionId };
}

export function checkConstitutionHealth(workbench, repoRoot) {
  const paths = bridgePaths(workbench);
  if (!paths) return { ok: false };

  const constitutionPath = path.join(workbench, "config", "constitution.json");
  const examplePath = path.join(repoRoot ?? "", "config", "constitution.example.json");

  const state = loadState(paths.stateFile);
  const date = today();
  if (state.constitutionAlert?.[date]) return { ok: existsSync(constitutionPath) };

  if (existsSync(constitutionPath)) {
    try {
      const c = JSON.parse(readFileSync(constitutionPath, "utf8"));
      if (c.ambitions?.length) return { ok: true };
    } catch {
      /* fall through */
    }
  }

  const hint = existsSync(examplePath)
    ? `复制 \`config/constitution.example.json\` → \`AgentWorkbench/config/constitution.json\``
    : "创建 AgentWorkbench/config/constitution.json";

  recordEscalation(workbench, {
    kind: "constitution_missing",
    reason: "Drive Engine 已禁用",
    detail: hint,
  });

  state.constitutionAlert = { ...(state.constitutionAlert ?? {}), [date]: true };
  saveState(paths.stateFile, state);
  return { ok: false };
}

export function refreshStatusBoard(workbench) {
  const paths = bridgePaths(workbench);
  if (!paths) return;
  ensureTemplateFiles(paths);

  const state = loadState(paths.stateFile);
  const orch = readOrchestratorSnapshot(workbench);
  const autonomy = readAutonomySnapshot(workbench);
  const head = parseQueueHead(workbench);
  const date = today();
  const ts = nowIso();

  const runningMissions = Object.entries(state.byMissionId ?? {}).map(([id, v]) => ({
    id,
    text: v.text?.slice(0, 60) ?? "",
    hash: v.hash,
  }));

  const lines = [
    "# Juno Status",
    "",
    `> 更新于 ${ts} · 历史见 [[Juno_Execution_Log]] · 门控见 [[Human_Escalations]]`,
    "",
    "## 运行时",
    "",
    `| 项 | 值 |`,
    `|----|-----|`,
    `| orchestrator | ${orch.activeRunStatus ?? "idle"} |`,
    `| active run | ${orch.activeRunId ?? "—"} |`,
    `| 今日迭代 | ${autonomy?.iterationsToday ?? "?"} / ${autonomy?.maxIterationsPerDay ?? "?"} |`,
    "",
    "## 队列头",
    "",
  ];

  if (head) {
    lines.push(
      `| 字段 | 值 |`,
      `|------|-----|`,
      `| run | \`${head.id}\` |`,
      `| mission | \`${head.mission_id ?? "?"}\` |`,
      `| phase | \`${head.phase_id ?? "?"}\` |`,
      `| kind | ${head.run_kind ?? "?"} |`,
      "",
    );
  } else {
    lines.push("_队列为空_\n", "");
  }

  lines.push("## Inbox 执行中", "");
  if (runningMissions.length) {
    for (const m of runningMissions) {
      lines.push(`- \`${m.id}\` — ${m.text}`);
    }
    lines.push("");
  } else {
    lines.push("_无 inbox 来源的活跃 mission_\n", "");
  }

  if (existsSync(paths.missionFile)) {
    const { items } = parseInboxLines(readFileSync(paths.missionFile, "utf8"));
    const pending = items.filter((i) => i.pending);
    if (pending.length) {
      lines.push("## 待摄入", "");
      for (const p of pending) {
        lines.push(`- [ ] ${p.text.slice(0, 100)}`);
      }
      lines.push("");
    }
  }

  if (state.briefIngest?.missionId) {
    lines.push(
      "## brief.md",
      "",
      `最近摄入：\`${state.briefIngest.missionId}\` @ ${state.briefIngest.ingestedAt ?? "?"}`,
      "",
    );
  }

  writeFileSync(paths.statusFile, `${lines.join("\n")}\n`, "utf8");
}

export function runVaultBridgeTick(workbench, repoRoot) {
  const paths = bridgePaths(workbench);
  if (!paths) return { ingested: 0 };

  checkConstitutionHealth(workbench, repoRoot);
  const inbox = syncInboxIngest(workbench, repoRoot);
  const brief = syncBriefIngest(workbench, repoRoot);
  refreshStatusBoard(workbench);

  return {
    ingested: inbox.ingested + (brief.ingested ? 1 : 0),
    briefIngested: brief.ingested,
  };
}

function summarizePush(pushResults) {
  if (!pushResults?.length) return { text: "", skipped: [] };
  const parts = [];
  const skipped = [];
  for (const pr of pushResults) {
    if (pr.pushed) parts.push(`${pr.repoId}@${pr.commit}`);
    else if (pr.skipped) {
      parts.push(`${pr.repoId}(skip:${pr.skipped})`);
      skipped.push(pr);
    } else if (pr.error) parts.push(`${pr.repoId}(err)`);
    else parts.push(`${pr.repoId}(no-op)`);
  }
  return {
    text: parts.length ? ` push=[${parts.join(", ")}]` : "",
    skipped,
  };
}

function parseVerifyFail(checkpoint) {
  return /##\s*VERIFY_REPORT[\s\S]*?\*\*FAIL\*\*|verdict:\s*BLOCK/i.test(checkpoint);
}

function parseReviewVerdictSimple(checkpoint) {
  const m = checkpoint.match(/verdict:\s*(PASS|REVISE|BLOCK)/i);
  return m?.[1]?.toUpperCase() ?? null;
}

export function completeInboxMission(workbench, missionId, pushResults) {
  const paths = bridgePaths(workbench);
  if (!paths) return false;
  const state = loadState(paths.stateFile);
  const track = state.byMissionId?.[missionId];
  if (!track?.hash) return false;

  const missionMd = readFileSync(paths.missionFile, "utf8");
  const { lines, items } = parseInboxLines(missionMd);
  const item = items.find((it) => it.hash === track.hash);
  if (!item) return false;

  lines[item.lineIndex] = `- [x] ${item.text} <!-- juno:${track.hash} done -->`;
  writeFileSync(paths.missionFile, `${lines.join("\n")}\n`, "utf8");

  if (state.byHash?.[track.hash]) {
    state.byHash[track.hash].status = "done";
    state.byHash[track.hash].completedAt = nowIso();
  }
  delete state.byMissionId[missionId];
  saveState(paths.stateFile, state);

  const date = today();
  const { text: pushText } = summarizePush(pushResults);
  appendLogEntry(paths.logFile, date, `${nowIso()} 🏁 mission 完成 \`${missionId}\`${pushText}`);
  refreshStatusBoard(workbench);
  return true;
}

/**
 * Record slot outcome to Vault execution log (and complete inbox on verify PASS).
 */
export async function recordSlotOutcome(workbench, repoRoot, opts) {
  const paths = bridgePaths(workbench);
  if (!paths) return;
  ensureTemplateFiles(paths);

  const { head, runKind, checkpoint, pushResults = [], action } = opts;
  const date = today();
  const missionId = head.mission_id ?? "?";
  const phaseId = head.phase_id ?? head.id;
  const runId = head.id;
  const cpPath = path.join(workbench, "runs", runId, "checkpoint.md");
  let entry = null;

  if (action === "revise") {
    entry = `${nowIso()} 🔄 review REVISE → 已排队 fix slot（\`${missionId}\` · ${phaseId} · ${runId}）`;
  } else if (runKind === "implement") {
    if (/STATUS:\s*COMPLETE/i.test(checkpoint)) {
      entry = `${nowIso()} ✅ implement PASS \`${missionId}\` · ${phaseId} · ${runId}`;
    }
  } else if (runKind === "review") {
    const verdict = parseReviewVerdictSimple(checkpoint);
    if (verdict === "PASS") {
      entry = `${nowIso()} ✅ review PASS \`${missionId}\` · ${phaseId} · ${runId}`;
    } else if (verdict === "BLOCK") {
      entry = `${nowIso()} ⛔ review BLOCK \`${missionId}\` · ${phaseId} · ${runId}`;
      recordEscalation(workbench, {
        kind: "review BLOCK",
        reason: "review gate blocked",
        missionId,
        runId,
        checkpointPath: cpPath,
      });
    }
  } else if (runKind === "verify") {
    const { text: pushText, skipped } = summarizePush(pushResults);
    if (/##\s*VERIFY_REPORT/i.test(checkpoint) && !parseVerifyFail(checkpoint)) {
      entry = `${nowIso()} ✅ verify PASS \`${missionId}\` · ${phaseId} · ${runId}${pushText}`;
      appendLogEntry(paths.logFile, date, entry);
      for (const pr of skipped) {
        recordEscalation(workbench, {
          kind: "git push skipped",
          reason: pr.skipped ?? "unknown",
          missionId,
          runId,
          detail: pr.repoId,
        });
      }
      if (stateTracksMission(workbench, missionId)) {
        completeInboxMission(workbench, missionId, pushResults);
      } else {
        refreshStatusBoard(workbench);
      }
      return;
    }
    if (parseVerifyFail(checkpoint)) {
      entry = `${nowIso()} ❌ verify FAIL \`${missionId}\` · ${phaseId} · ${runId}`;
      recordEscalation(workbench, {
        kind: "verify FAIL",
        reason: "verify gate failed",
        missionId,
        runId,
        checkpointPath: cpPath,
      });
    }
  }

  if (entry) appendLogEntry(paths.logFile, date, entry);
  refreshStatusBoard(workbench);
}

function stateTracksMission(workbench, missionId) {
  const paths = bridgePaths(workbench);
  if (!paths) return false;
  const state = loadState(paths.stateFile);
  return Boolean(state.byMissionId?.[missionId]);
}

export function appendDailySummary(workbench, summary) {
  const paths = bridgePaths(workbench);
  if (!paths) return;
  ensureTemplateFiles(paths);
  const date = today();
  const state = loadState(paths.stateFile);
  if (state.dailySummary?.[date]) return;

  const lines = [
    `${nowIso()} 📊 日摘要`,
    `  - autonomy ticks: ${summary.ticks ?? "?"}`,
    `  - cap filled: ${summary.capFilled ? "yes" : "no"}`,
    `  - export: ${summary.exportDir ?? "—"}`,
    `  - purge deleted: ${summary.purgeDeleted ?? 0}`,
  ];
  appendLogEntry(paths.logFile, date, lines.join("\n"));
  state.dailySummary = { ...(state.dailySummary ?? {}), [date]: true };
  saveState(paths.stateFile, state);
  refreshStatusBoard(workbench);
}
