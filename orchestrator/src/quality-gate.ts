/**
 * Programmatic quality gates — complements LLM review (catches Goodhart / typography bugs).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/** Strip spaced-bold padding artifacts; returns cleaned text and approximate fixes applied. */
export function fixSpacedBoldInText(text: string): { text: string; fixesApplied: number } {
  let result = text;
  let fixesApplied = 0;
  const before = countSpacedBoldArtifacts(result);

  for (let pass = 0; pass < 8; pass++) {
    const prev = result;
    result = result.replace(/\*\*\s+\*\*\s+\*\*/g, () => {
      fixesApplied += 1;
      return "";
    });
    result = result.replace(/\*\*([^*\n]{1,12}?)\*\*(\s+\*\*)+/g, (_, inner: string) => {
      fixesApplied += 1;
      return inner;
    });
    result = result.replace(/\*\*\s+\*\*/g, () => {
      fixesApplied += 1;
      return "";
    });
    if (result === prev) break;
  }

  const after = countSpacedBoldArtifacts(result);
  return { text: result, fixesApplied: Math.max(fixesApplied, before - after) };
}

export interface ChapterAutoFixResult {
  chapter: number;
  path: string;
  fixed: boolean;
  skippedReason?: string;
  fixesApplied: number;
  okAfter: boolean;
}

/** Programmatic repair when spaced-bold is the only fail reason. */
export function autoFixChapterSpacedBold(
  workbench: string,
  chapterNum: number,
  opts: { strictLength?: boolean } = {},
): ChapterAutoFixResult {
  const p = chapterFilePath(workbench, chapterNum);
  if (!existsSync(p)) {
    return { chapter: chapterNum, path: p, fixed: false, skippedReason: "missing", fixesApplied: 0, okAfter: false };
  }
  const original = readFileSync(p, "utf8");
  const before = validateChapterText(original, chapterNum, opts);
  const failCodes = before.issues.filter((i) => i.severity === "fail").map((i) => i.code);
  if (failCodes.length === 0) {
    return { chapter: chapterNum, path: p, fixed: false, skippedReason: "already_ok", fixesApplied: 0, okAfter: true };
  }
  if (!failCodes.every((c) => c === "spaced_bold")) {
    return {
      chapter: chapterNum,
      path: p,
      fixed: false,
      skippedReason: `other_fails:${failCodes.join(",")}`,
      fixesApplied: 0,
      okAfter: false,
    };
  }
  const { text, fixesApplied } = fixSpacedBoldInText(original);
  writeFileSync(p, text, "utf8");
  const after = validateChapterText(text, chapterNum, opts);
  return {
    chapter: chapterNum,
    path: p,
    fixed: true,
    fixesApplied,
    okAfter: after.ok,
  };
}

/** Fix all chapters that fail only on spaced-bold. */
export function autoFixBookSpacedBoldOnly(
  workbench: string,
  opts: { strictLength?: boolean; chapters?: number[] } = {},
): ChapterAutoFixResult[] {
  const scan = scanBookQuality(workbench, opts);
  const targets = opts.chapters ?? scan.failedChapters;
  return targets.map((ch) => autoFixChapterSpacedBold(workbench, ch, opts));
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
