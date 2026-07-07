/**
 * Vault bridge core — Obsidian inbox + execution log ↔ Workbench runtime.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
    stateFile: path.join(workbench, "state", "vault-bridge-state.json"),
  };
}

export function ensureTemplateFiles(paths) {
  mkdirSync(path.dirname(paths.missionFile), { recursive: true });
  mkdirSync(path.dirname(paths.logFile), { recursive: true });
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
}

export function loadState(stateFile) {
  if (!existsSync(stateFile)) {
    return { byHash: {}, byMissionId: {}, dailyHeartbeat: {}, dailySummary: {} };
  }
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8"));
    return {
      byHash: s.byHash ?? s.processed ?? {},
      byMissionId: s.byMissionId ?? {},
      dailyHeartbeat: s.dailyHeartbeat ?? {},
      dailySummary: s.dailySummary ?? {},
    };
  } catch {
    return { byHash: {}, byMissionId: {}, dailyHeartbeat: {}, dailySummary: {} };
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

function upsertDailySection(logMd, date) {
  const heading = `## ${date}`;
  if (logMd.includes(`\n${heading}\n`) || logMd.startsWith(`${heading}\n`)) {
    return logMd;
  }
  const suffix = logMd.endsWith("\n") ? "" : "\n";
  return `${logMd}${suffix}\n${heading}\n\n`;
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

function parseBriefMissionId(stdout, workbench) {
  const text = stdout.trim();
  if (text) {
    for (const line of text.split("\n").reverse()) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const j = JSON.parse(t);
        if (j.missionId) return j.missionId;
        if (j.plan?.missionId) return j.plan.missionId;
      } catch {
        /* continue */
      }
    }
  }
  const planPath = path.join(workbench, "state", "last-brief-plan.json");
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      if (plan.missionId) return plan.missionId;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function runBrief(repoRoot, workbench, missionText) {
  const r = spawnSync("node", ["scripts/juno-brief.mjs", "--execute", missionText], {
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
    missionId: parseBriefMissionId(r.stdout ?? "", workbench),
  };
}

function markInboxRunning(lines, item, hash) {
  const base = item.text;
  lines[item.lineIndex] = `- [/] ${base} <!-- juno:${hash} -->`;
}

export function syncInboxIngest(workbench, repoRoot) {
  const paths = bridgePaths(workbench);
  if (!paths) return { ingested: 0 };
  ensureTemplateFiles(paths);

  const state = loadState(paths.stateFile);
  const date = today();

  if (state.dailyHeartbeat?.[date] !== true) {
    appendLogEntry(paths.logFile, date, `${nowIso()} 心跳：Juno 在线，等待/执行 missions。`);
    state.dailyHeartbeat = { ...(state.dailyHeartbeat ?? {}), [date]: true };
  }

  const missionMd = readFileSync(paths.missionFile, "utf8");
  const { lines, items } = parseInboxLines(missionMd);
  let ingested = 0;
  let changed = false;

  for (const item of items) {
    if (!item.pending) continue;
    if (state.byHash?.[item.hash]?.status === "running") continue;

    const res = runBrief(repoRoot, workbench, item.text);
    if (!res.ok) {
      appendLogEntry(
        paths.logFile,
        date,
        `${nowIso()} ❌ 摄入失败：${item.text.slice(0, 120)}（exit=${res.status}）`,
      );
      continue;
    }

    const missionId = res.missionId ?? `unknown-${item.hash}`;
    markInboxRunning(lines, item, item.hash);
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

function summarizePush(pushResults) {
  if (!pushResults?.length) return "";
  const parts = pushResults.map((pr) => {
    if (pr.pushed) return `${pr.repoId}@${pr.commit}`;
    if (pr.skipped) return `${pr.repoId}(skip:${pr.skipped})`;
    if (pr.error) return `${pr.repoId}(err)`;
    return `${pr.repoId}(no-op)`;
  });
  return parts.length ? ` push=[${parts.join(", ")}]` : "";
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
  appendLogEntry(
    paths.logFile,
    date,
    `${nowIso()} 🏁 mission 完成 \`${missionId}\`${summarizePush(pushResults)}`,
  );
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
    }
  } else if (runKind === "verify") {
    if (/##\s*VERIFY_REPORT/i.test(checkpoint) && !parseVerifyFail(checkpoint)) {
      entry = `${nowIso()} ✅ verify PASS \`${missionId}\` · ${phaseId} · ${runId}${summarizePush(pushResults)}`;
      appendLogEntry(paths.logFile, date, entry);
      if (stateTracksMission(workbench, missionId)) {
        completeInboxMission(workbench, missionId, pushResults);
      }
      return;
    }
    if (parseVerifyFail(checkpoint)) {
      entry = `${nowIso()} ❌ verify FAIL \`${missionId}\` · ${phaseId} · ${runId}`;
    }
  }

  if (entry) appendLogEntry(paths.logFile, date, entry);
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
}
