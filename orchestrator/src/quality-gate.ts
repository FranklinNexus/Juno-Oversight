/**
 * Programmatic quality gates — complements LLM review (catches Goodhart / typography bugs).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ChapterQualityIssue {
  code: string;
  message: string;
  severity: "fail" | "warn";
}

export interface ChapterQualityReport {
  chapter: number;
  path: string;
  han: number;
  ok: boolean;
  issues: ChapterQualityIssue[];
}

export interface BookQualityScan {
  missionId: string;
  scannedAt: string;
  totalHan: number;
  failedChapters: number[];
  reports: ChapterQualityReport[];
}

export const BOOK_MISSION_ID = "juno-axiom-book-2026";
export const CHAPTER_COUNT = 20;
export const CHARS_PER_CHAPTER = 5000;

export function countHan(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
}

/** ch18-style artifact: `** ** **词** ** **` spaced-bold padding */
export function countSpacedBoldArtifacts(text: string): number {
  const triple = (text.match(/\*\*\s+\*\*\s+\*\*/g) ?? []).length;
  const innerSpace = (text.match(/\*\*[^*\n]{1,12}\*\*\s+\*\*/g) ?? []).length;
  return triple + innerSpace;
}

export function validateChapterText(
  text: string,
  chapterNum: number,
  opts: { minHan?: number; maxHan?: number; strictLength?: boolean } = {},
): ChapterQualityReport {
  const minHan = opts.minHan ?? CHARS_PER_CHAPTER - 500;
  const maxHan = opts.maxHan ?? CHARS_PER_CHAPTER + 500;
  const strictLength = opts.strictLength ?? true;
  const issues: ChapterQualityIssue[] = [];
  const han = countHan(text);

  if (strictLength && (han < minHan || han > maxHan)) {
    issues.push({
      code: "han_range",
      message: `汉字数 ${han}，要求 ${minHan}–${maxHan}`,
      severity: "fail",
    });
  } else if (!strictLength && han > maxHan * 3) {
    issues.push({
      code: "han_bloat",
      message: `汉字数 ${han} 严重超标（>${maxHan * 3}）`,
      severity: "fail",
    });
  }

  const spaced = countSpacedBoldArtifacts(text);
  if (spaced >= 2) {
    issues.push({
      code: "spaced_bold",
      message: `检测到 ${spaced} 处 spaced-bold 凑字 artifact（须删除字间 ** 插入）`,
      severity: "fail",
    });
  }

  const lines = text.split("\n");
  const head = lines.slice(0, 12).join("\n");
  if (!/公理|M1|A[1-5]/i.test(head)) {
    issues.push({
      code: "axiom_tag",
      message: "首段未标注相关公理编号",
      severity: "fail",
    });
  }

  if (!/(?:\*{0,2})本书主张(?:\*{0,2})[：:]/.test(text)) {
    issues.push({
      code: "thesis_marker",
      message: "缺少「本书主张：」段",
      severity: "fail",
    });
  }

  const listLines = lines.filter((l) => /^\s*[-*]\s/.test(l)).length;
  const listRatio = lines.length > 0 ? listLines / lines.length : 0;
  if (listRatio > 0.22) {
    issues.push({
      code: "list_ratio",
      message: `列表行占比 ${(listRatio * 100).toFixed(0)}% > 20%`,
      severity: "warn",
    });
  }

  const fails = issues.filter((i) => i.severity === "fail");
  return {
    chapter: chapterNum,
    path: `chapters/ch${String(chapterNum).padStart(2, "0")}.md`,
    han,
    ok: fails.length === 0,
    issues,
  };
}

export function chapterFilePath(workbench: string, chapterNum: number): string {
  return path.join(
    workbench,
    "missions",
    BOOK_MISSION_ID,
    "chapters",
    `ch${String(chapterNum).padStart(2, "0")}.md`,
  );
}

export function scanBookQuality(
  workbench: string,
  opts: { strictLength?: boolean } = {},
): BookQualityScan {
  const reports: ChapterQualityReport[] = [];
  let totalHan = 0;

  for (let i = 1; i <= CHAPTER_COUNT; i++) {
    const p = chapterFilePath(workbench, i);
    if (!existsSync(p)) {
      reports.push({
        chapter: i,
        path: `chapters/ch${String(i).padStart(2, "0")}.md`,
        han: 0,
        ok: false,
        issues: [{ code: "missing", message: "章节文件不存在", severity: "fail" }],
      });
      continue;
    }
    const text = readFileSync(p, "utf8");
    const report = validateChapterText(text, i, opts);
    report.path = p;
    totalHan += report.han;
    reports.push(report);
  }

  const failedChapters = reports.filter((r) => !r.ok).map((r) => r.chapter);
  return {
    missionId: BOOK_MISSION_ID,
    scannedAt: new Date().toISOString(),
    totalHan,
    failedChapters,
    reports,
  };
}

export function mustFixFromQualityReport(report: ChapterQualityReport): string[] {
  return report.issues
    .filter((i) => i.severity === "fail")
    .map((i) => `[ch${String(report.chapter).padStart(2, "0")}] ${i.code}: ${i.message}`);
}
