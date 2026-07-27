import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readWorkbenchConfig } from "./vault-bridge-core.mjs";

const KPI_COLUMNS = [
  "date",
  "ticks",
  "capFilled",
  "escalations",
  "strategy",
  "topMission",
  "queueHead",
  "idleAction",
  "missionDone",
  "verifyPass",
  "reviewRework",
  "reviewBlock",
  "verifyPassRate",
  "reworkRate",
];

const KPI_DEFAULTS = ["", "0", "no", "0", "balanced", "—", "no", "—", "0", "0", "0", "0", "—", "—"];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function readJson(filePath, fallback = {}) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function countEscalationsToday(escalationsFile, date) {
  if (!existsSync(escalationsFile)) return 0;
  const md = readFileSync(escalationsFile, "utf8");
  const marker = `## ${date}`;
  const idx = md.indexOf(marker);
  if (idx < 0) return 0;
  const rest = md.slice(idx + marker.length);
  const end = rest.search(/\n##\s+\d{4}-\d{2}-\d{2}/);
  const section = end >= 0 ? rest.slice(0, end) : rest;
  return (section.match(/^\s*-\s+/gm) ?? []).length;
}

function dailySection(markdown, date) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${date}`);
  if (start < 0) return "";
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+\d{4}-\d{2}-\d{2}\s*$/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join("\n");
}

function countMatches(text, pattern) {
  return text.match(pattern)?.length ?? 0;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/** Parse only persisted gate outcomes; no model claims are treated as delivery evidence. */
export function parseExecutionOutcomeMetrics(markdown, date) {
  const section = dailySection(markdown ?? "", date);
  const implementPass = countMatches(section, /✅ implement PASS\b/g);
  const reviewPass = countMatches(section, /✅ review PASS\b/g);
  const reviewRework = countMatches(section, /🔄 review REVISE\b/g);
  const reviewBlock = countMatches(section, /⛔ review BLOCK\b/g);
  const verifyPass = countMatches(section, /✅ verify PASS\b/g);
  const verifyFail = countMatches(section, /❌ verify FAIL\b/g);
  const missionDone = countMatches(section, /🏁 mission 完成/g);

  return {
    implementPass,
    reviewPass,
    reviewRework,
    reviewBlock,
    verifyPass,
    verifyFail,
    missionDone,
    verifyPassRate: ratio(verifyPass, verifyPass + verifyFail),
    reworkRate: ratio(reviewRework, reviewPass + reviewRework + reviewBlock),
  };
}

function normalizeRow(columns) {
  return KPI_COLUMNS.map((_, index) => columns[index] ?? KPI_DEFAULTS[index]);
}

function parseTableRows(md) {
  const lines = md.split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    if (line.includes("---")) continue;
    const cols = line
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cols[0] === "date") continue;
    if (cols.length >= 8) rows.push(normalizeRow(cols));
  }
  return rows;
}

function upsertRow(rows, row) {
  const idx = rows.findIndex((r) => r[0] === row[0]);
  if (idx >= 0) rows[idx] = row;
  else rows.push(row);
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return rows;
}

function buildMarkdown(rows) {
  const header = [
    "# KPI Weekly",
    "",
    "> 自动生成：衡量这套自治架构对项目推进效率的提升。",
    "",
    `| ${KPI_COLUMNS.join(" | ")} |`,
    "|---|---:|:---:|---:|---|---|:---:|---|---:|---:|---:|---:|---:|---:|",
  ];
  const body = rows.map((r) => `| ${normalizeRow(r).join(" | ")} |`);
  return `${[...header, ...body, ""].join("\n")}`;
}

function rateText(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function rowToJson(row) {
  const r = normalizeRow(row);
  return {
    date: r[0],
    ticks: Number(r[1]) || 0,
    capFilled: r[2] === "yes",
    escalations: Number(r[3]) || 0,
    strategy: r[4],
    topMission: r[5],
    queueHead: r[6] === "yes",
    idleAction: r[7],
    missionDone: Number(r[8]) || 0,
    verifyPass: Number(r[9]) || 0,
    reviewRework: Number(r[10]) || 0,
    reviewBlock: Number(r[11]) || 0,
    verifyPassRate: r[12] === "—" ? null : Number.parseFloat(r[12]) / 100,
    reworkRate: r[13] === "—" ? null : Number.parseFloat(r[13]) / 100,
  };
}

export function updateWeeklyKpi(workbench, overrideDate) {
  const cfg = readWorkbenchConfig(workbench);
  if (!cfg) return { ok: false, reason: "missing config.yaml vault_path" };
  const date = overrideDate ?? today();
  const junoRoot = path.join(cfg.vaultPath, cfg.vaultJunoRoot);
  mkdirSync(junoRoot, { recursive: true });

  const kpiFile = path.join(junoRoot, "KPI_Weekly.md");
  const kpiJsonFile = path.join(junoRoot, "KPI_Weekly.json");
  const escalationsFile = path.join(junoRoot, "Human_Escalations.md");
  const executionLogFile = path.join(junoRoot, "Juno_Execution_Log.md");
  const dailyRun = readJson(path.join(workbench, "state", "daily-juno.json"), {});
  const autonomy = readJson(path.join(workbench, "state", "bounded-autonomy.json"), {});
  const drive = readJson(path.join(workbench, "state", "drive-engine.json"), {});
  const planner = readJson(path.join(workbench, "state", "mission-planner.json"), {});
  const nowYaml = path.join(workbench, "queue", "now.yaml");

  const queueHead = existsSync(nowYaml) && /\bnow:\s*\n\s*-\s+id:/m.test(readFileSync(nowYaml, "utf8"));
  const escalations = countEscalationsToday(escalationsFile, date);
  const executionMetrics = parseExecutionOutcomeMetrics(
    existsSync(executionLogFile) ? readFileSync(executionLogFile, "utf8") : "",
    date,
  );

  const row = normalizeRow([
    date,
    String(dailyRun.ticks ?? autonomy.iterationsToday ?? 0),
    dailyRun.capFilled ? "yes" : "no",
    String(escalations),
    String(drive.driveStrategy ?? "balanced"),
    String(drive.lastTopMissionId ?? "—"),
    queueHead ? "yes" : "no",
    String(planner?.decision?.action ?? "—"),
    String(executionMetrics.missionDone),
    String(executionMetrics.verifyPass),
    String(executionMetrics.reviewRework),
    String(executionMetrics.reviewBlock),
    rateText(executionMetrics.verifyPassRate),
    rateText(executionMetrics.reworkRate),
  ]);

  const existing = existsSync(kpiFile) ? readFileSync(kpiFile, "utf8") : "";
  const rows = upsertRow(parseTableRows(existing), row);
  const generatedAt = new Date().toISOString();
  const latest = {
    ...rowToJson(row),
    verifyPassRate: executionMetrics.verifyPassRate,
    reworkRate: executionMetrics.reworkRate,
  };
  const jsonRows = rows.map(rowToJson).map((item) => (item.date === date ? latest : item));
  const stateKpiFile = path.join(workbench, "state", "kpi-latest.json");
  writeFileSync(kpiFile, buildMarkdown(rows), "utf8");
  writeFileSync(
    kpiJsonFile,
    `${JSON.stringify(
      {
        version: 1,
        generatedAt,
        latest,
        rows: jsonRows,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  mkdirSync(path.dirname(stateKpiFile), { recursive: true });
  writeFileSync(
    stateKpiFile,
    `${JSON.stringify({ version: 1, generatedAt, latest }, null, 2)}\n`,
    "utf8",
  );

  return {
    ok: true,
    filePath: kpiFile,
    jsonFilePath: kpiJsonFile,
    stateFilePath: stateKpiFile,
    row,
    metrics: executionMetrics,
  };
}
