/**
 * Copy Juno artifacts to an ISOLATED export folder (read-only from Workbench).
 * Never writes to Obsidian Vault, repo, or Workbench itself.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { loadDailySchedule } from "./daily-schedule.js";

const FORBIDDEN_PATH_MARKERS = [
  "obsidian vault",
  "juno oversight",
  "agentworkbench",
  "\\windows\\",
  "\\program files",
  "\\program files (x86)",
  "\\programdata\\",
  "system32",
  "desktopdata\\entrepreneurship",
];

export interface ExportContext {
  workbenchRoot: string;
  exportRoot: string;
  repoRoot?: string;
  vaultPath?: string;
}

export interface DailyExportResult {
  exportDir: string;
  digestPath: string;
  copiedFiles: string[];
  prunedOldExports: string[];
  errors: string[];
}

function resolveRoot(p: string): string {
  return path.resolve(p);
}

/** Export destination must be a dedicated folder, not vault/repo/workbench/OS. */
export function validateExportRoot(
  exportRoot: string,
  ctx: Pick<ExportContext, "workbenchRoot" | "repoRoot" | "vaultPath">,
): { ok: true; resolved: string } | { ok: false; reason: string } {
  const resolved = resolveRoot(exportRoot);
  const norm = resolved.replace(/\\/g, "/").toLowerCase();

  for (const marker of FORBIDDEN_PATH_MARKERS) {
    if (norm.includes(marker.replace(/\\/g, "/"))) {
      return { ok: false, reason: `export root matches forbidden marker: ${marker}` };
    }
  }

  const wb = resolveRoot(ctx.workbenchRoot).replace(/\\/g, "/").toLowerCase();
  if (norm === wb || norm.startsWith(wb + "/")) {
    return { ok: false, reason: "export root must not be inside AgentWorkbench" };
  }

  if (ctx.repoRoot) {
    const repo = resolveRoot(ctx.repoRoot).replace(/\\/g, "/").toLowerCase();
    if (norm === repo || norm.startsWith(repo + "/")) {
      return { ok: false, reason: "export root must not be inside Juno Oversight repo" };
    }
  }

  if (ctx.vaultPath) {
    const vault = resolveRoot(ctx.vaultPath).replace(/\\/g, "/").toLowerCase();
    if (norm === vault || norm.startsWith(vault + "/") || vault.startsWith(norm + "/")) {
      return { ok: false, reason: "export root must not overlap Obsidian Vault" };
    }
  }

  return { ok: true, resolved };
}

function safeCopy(src: string, dest: string, exportRoot: string): boolean {
  const resolvedDest = resolveRoot(dest);
  const root = resolveRoot(exportRoot);
  if (!resolvedDest.startsWith(root + path.sep)) return false;
  mkdirSync(path.dirname(resolvedDest), { recursive: true });
  copyFileSync(src, resolvedDest);
  return true;
}

function readVaultPath(workbench: string): string | undefined {
  const cfg = path.join(workbench, "config.yaml");
  if (!existsSync(cfg)) return undefined;
  try {
    const m = readFileSync(cfg, "utf8").match(/vault_path:\s*["']?([^"'\n]+)/i);
    return m?.[1]?.trim().replace(/\\\\/g, "\\");
  } catch {
    return undefined;
  }
}

function listMissionIds(workbench: string, filter: string[]): string[] {
  const missionsDir = path.join(workbench, "missions");
  if (!existsSync(missionsDir)) return [];
  const all = readdirSync(missionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  if (filter.length === 0) return all;
  return all.filter((id) => filter.includes(id));
}

function buildDigest(
  date: string,
  workbench: string,
  copied: string[],
  autonomy?: Record<string, unknown>,
  planner?: Record<string, unknown>,
): string {
  const lines = [
    "---",
    `date: ${date}`,
    "tags: [juno, daily-export]",
    "source: juno-daily-export",
    "---",
    "",
    `# Juno 日报 ${date}`,
    "",
    "> 本文件由 `pnpm daily:juno` 自动生成，位于**隔离导出目录**，非 Vault 直写。",
    "",
    "## 自主迭代",
    "",
  ];

  if (autonomy) {
    lines.push(
      `- 日期: ${autonomy.date ?? date}`,
      `- 今日迭代: ${autonomy.iterationsToday ?? "?"}`,
      `- 末次动作: ${autonomy.lastAction ?? "—"}`,
      `- 末次 Mission: ${autonomy.lastMissionId ?? "—"}`,
      "",
    );
  }

  if (planner?.decision) {
    const d = planner.decision as { action?: string; reason?: string };
    lines.push("## Planner 末次决策", "", `- action: \`${d.action}\``, `- reason: ${d.reason ?? ""}`, "");
  }

  lines.push("## 导出文件", "", ...copied.map((f) => `- \`${f}\``), "");

  const qualityPath = path.join(workbench, "state", "quality-scan.json");
  if (existsSync(qualityPath)) {
    try {
      const q = JSON.parse(readFileSync(qualityPath, "utf8")) as {
        failedChapters?: number[];
        totalHan?: number;
      };
      lines.push(
        "## 书稿 Quality",
        "",
        `- 总汉字: ${q.totalHan ?? "?"}`,
        `- 待修章节: ${(q.failedChapters ?? []).join(", ") || "无"}`,
        "",
      );
    } catch {
      /* ignore */
    }
  }

  lines.push("---", "", "*隔离说明：仅复制自 AgentWorkbench；Vault 与仓库未被本脚本修改。*", "");
  return lines.join("\n");
}

export function pruneOldExportDays(exportRoot: string, retentionDays: number): string[] {
  if (retentionDays <= 0 || !existsSync(exportRoot)) return [];
  const pruned: string[] = [];
  const now = Date.now();
  const maxAge = retentionDays * 86_400_000;

  for (const ent of readdirSync(exportRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ent.name)) continue;
    const p = path.join(exportRoot, ent.name);
    try {
      if (now - statSync(p).mtimeMs > maxAge) {
        rmSync(p, { recursive: true, force: true });
        pruned.push(ent.name);
      }
    } catch {
      /* skip */
    }
  }
  return pruned;
}

/** Export today's bundle to isolated folder. */
export function runDailyExport(
  workbench: string,
  opts: { repoRoot?: string; date?: string } = {},
): DailyExportResult {
  const schedule = loadDailySchedule(workbench);
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const vaultPath = readVaultPath(workbench);
  const validation = validateExportRoot(schedule.exportRoot ?? "E:\\JunoDailyExport", {
    workbenchRoot: workbench,
    repoRoot: opts.repoRoot,
    vaultPath,
  });

  const errors: string[] = [];
  const copiedFiles: string[] = [];

  if (!validation.ok) {
    return {
      exportDir: "",
      digestPath: "",
      copiedFiles: [],
      prunedOldExports: [],
      errors: [validation.reason],
    };
  }

  const exportRoot = validation.resolved;
  const exportDir = path.join(exportRoot, date);
  const artifactsDir = path.join(exportDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });

  const stateSnaps = [
    "bounded-autonomy.json",
    "mission-planner.json",
    "quality-scan.json",
    "self-optimize.json",
    "daily-juno.json",
  ];
  for (const name of stateSnaps) {
    const src = path.join(workbench, "state", name);
    if (!existsSync(src)) continue;
    const dest = path.join(artifactsDir, "state", name);
    if (safeCopy(src, dest, exportRoot)) {
      copiedFiles.push(path.relative(exportDir, dest).replace(/\\/g, "/"));
    }
  }

  if (schedule.exportObsidianBundle !== false) {
    const missionIds = listMissionIds(workbench, schedule.exportMissionIds ?? []);
    for (const missionId of missionIds) {
      const missionDir = path.join(workbench, "missions", missionId);
      for (const rel of ["north-star.md", "progress.md", "checkpoint.md", "decision-log.md"]) {
        const src = path.join(missionDir, rel);
        if (!existsSync(src)) continue;
        const dest = path.join(artifactsDir, "missions", missionId, rel);
        if (safeCopy(src, dest, exportRoot)) {
          copiedFiles.push(path.relative(exportDir, dest).replace(/\\/g, "/"));
        }
      }

      const chaptersDir = path.join(missionDir, "chapters");
      if (existsSync(chaptersDir)) {
        for (const f of readdirSync(chaptersDir).filter((n) => n.endsWith(".md"))) {
          const src = path.join(chaptersDir, f);
          const dest = path.join(artifactsDir, "missions", missionId, "chapters", f);
          if (safeCopy(src, dest, exportRoot)) {
            copiedFiles.push(path.relative(exportDir, dest).replace(/\\/g, "/"));
          }
        }
      }

      const bookFull = path.join(missionDir, "book", "全书.md");
      if (existsSync(bookFull)) {
        const dest = path.join(artifactsDir, "missions", missionId, "book", "全书.md");
        if (safeCopy(bookFull, dest, exportRoot)) {
          copiedFiles.push(path.relative(exportDir, dest).replace(/\\/g, "/"));
        }
      }
    }
  }

  let autonomy: Record<string, unknown> | undefined;
  let planner: Record<string, unknown> | undefined;
  const ap = path.join(workbench, "state", "bounded-autonomy.json");
  const pp = path.join(workbench, "state", "mission-planner.json");
  if (existsSync(ap)) {
    try {
      autonomy = JSON.parse(readFileSync(ap, "utf8")) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  if (existsSync(pp)) {
    try {
      planner = JSON.parse(readFileSync(pp, "utf8")) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }

  const digestPath = path.join(exportDir, `Juno日报_${date}.md`);
  writeFileSync(
    digestPath,
    buildDigest(date, workbench, copiedFiles, autonomy, planner),
    "utf8",
  );
  copiedFiles.unshift(path.basename(digestPath));

  const prunedOldExports = pruneOldExportDays(
    exportRoot,
    schedule.exportRetentionDays ?? 30,
  );

  return { exportDir, digestPath, copiedFiles, prunedOldExports, errors };
}
