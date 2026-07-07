import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readWorkbenchConfig } from "./vault-bridge-core.mjs";

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
    if (cols.length >= 8) rows.push(cols);
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
    "| date | ticks | capFilled | escalations | strategy | topMission | queueHead | idleAction |",
    "|---|---:|:---:|---:|---|---|:---:|---|",
  ];
  const body = rows.map(
    (r) =>
      `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} | ${r[5]} | ${r[6]} | ${r[7]} |`,
  );
  return `${[...header, ...body, ""].join("\n")}`;
}

export function updateWeeklyKpi(workbench, overrideDate) {
  const cfg = readWorkbenchConfig(workbench);
  if (!cfg) return { ok: false, reason: "missing config.yaml vault_path" };
  const date = overrideDate ?? today();
  const junoRoot = path.join(cfg.vaultPath, cfg.vaultJunoRoot);
  mkdirSync(junoRoot, { recursive: true });

  const kpiFile = path.join(junoRoot, "KPI_Weekly.md");
  const escalationsFile = path.join(junoRoot, "Human_Escalations.md");
  const dailyRun = readJson(path.join(workbench, "state", "daily-juno.json"), {});
  const autonomy = readJson(path.join(workbench, "state", "bounded-autonomy.json"), {});
  const drive = readJson(path.join(workbench, "state", "drive-engine.json"), {});
  const planner = readJson(path.join(workbench, "state", "mission-planner.json"), {});
  const nowYaml = path.join(workbench, "queue", "now.yaml");

  const queueHead = existsSync(nowYaml) && /\bnow:\s*\n\s*-\s+id:/m.test(readFileSync(nowYaml, "utf8"));
  const escalations = countEscalationsToday(escalationsFile, date);

  const row = [
    date,
    String(dailyRun.ticks ?? autonomy.iterationsToday ?? 0),
    dailyRun.capFilled ? "yes" : "no",
    String(escalations),
    String(drive.driveStrategy ?? "balanced"),
    String(drive.lastTopMissionId ?? "—"),
    queueHead ? "yes" : "no",
    String(planner?.decision?.action ?? "—"),
  ];

  const existing = existsSync(kpiFile) ? readFileSync(kpiFile, "utf8") : "";
  const rows = upsertRow(parseTableRows(existing), row);
  writeFileSync(kpiFile, buildMarkdown(rows), "utf8");

  return { ok: true, filePath: kpiFile, row };
}
