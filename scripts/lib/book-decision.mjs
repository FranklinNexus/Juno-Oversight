/**
 * Juno autonomous book planning — axioms, outline, rubric from first principles.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export const BOOK_MISSION_ID = "juno-axiom-book-2026";
export const CHAPTER_COUNT = 20;
export const CHARS_PER_CHAPTER = 5000;
export const TOTAL_CHARS_TARGET = 100_000;

export function missionDir(workbench) {
  return path.join(workbench, "missions", BOOK_MISSION_ID);
}

function junoRoot() {
  return process.env.JUNO_OVERSIGHT_ROOT ?? "C:\\Users\\kfr34\\Desktop\\Entrepreneurship\\Juno Oversight";
}

function countHan(text) {
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
}

export function readOptional(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export function buildAxiomsDoc() {
  return `# 公理体系 — Juno 自主选定

> 决策依据：charter 四条 + juno-agi-north-star L0–L8 + 第一性原理。

## 元公理 M1 可错性

任何命题必须留有可能被经验或推理推翻的接口。

## 五条核心公理

**A1 世界可压缩**：智能体面对的世界在观测与算力约束下存在可学习的生成结构。

**A2 行动即不可逆承诺**：智能是在不确定性下对算力、时间与声誉的不可逆分配。

**A3 真理以预测误差锚定**：知识价值由压缩与预测能力度量；修正优先于单次生成。

**A4 自主在边界内递归**：自我修改必须携带 scope-lock 与 halt 条件。

**A5 意义生于关系**：符号与语义由交互史与他者构成固定点。

## 与 Juno 文献映射

A1↔world-model；A2↔tool-agi；A3↔eval-agi；A4↔bounded-autonomy；A5↔multi-agent-agi
`;
}

export function buildOutlineDoc() {
  const chapters = [
    ["01", "序言：为何从公理写一本书"],
    ["02", "可错性与认识论义务"],
    ["03", "A1 世界可压缩"],
    ["04", "压缩的极限"],
    ["05", "A2 行动即承诺"],
    ["06", "工具、身体与外延心智"],
    ["07", "A3 真理与预测误差"],
    ["08", "从误差到科学：制度设计"],
    ["09", "A4 有边界的递归"],
    ["10", "Overseer：一种 bounded 递归架构"],
    ["11", "A5 意义与他者"],
    ["12", "语言、模型与谎言"],
    ["13", "Scaling 不是公理"],
    ["14", "世界模型与 AGI 分层"],
    ["15", "记忆、叙事与自我"],
    ["16", "经济与算力伦理"],
    ["17", "风险与治理"],
    ["18", "第一梯队著作的标准"],
    ["19", "未完成：开放问题"],
    ["20", "结语：从公理生长"],
  ];
  const lines = chapters.map(
    ([n, title]) => `- **第${n}章 ${title}**（~${CHARS_PER_CHAPTER} 字）`,
  );
  return `# Outline — Juno 自主

**书名**：《从公理生长：智能、世界与 Overseer》

**总规模**：${TOTAL_CHARS_TARGET} 字 = ${CHAPTER_COUNT} 章 × ~${CHARS_PER_CHAPTER}

${lines.join("\n")}
`;
}

export function buildQualityRubric() {
  return `# Quality Rubric — 第一梯队

## 硬门禁（fail → REVISE）

1. 每章首段标注相关公理编号
2. 论证链无跳步；有例子或思想实验
3. 每章 ≥1 处「本书主张：」原创综合
4. 反灌水：可删段落 ≤15%
5. 单章 ${CHARS_PER_CHAPTER - 500}–${CHARS_PER_CHAPTER + 500} 汉字
6. 书面汉语；列表 ≤ 全文 20%

## debate 规则

反方找到一处可修复缺陷即可 REVISE；merge 前抽样 3 章做文体交叉检查。
`;
}

export function buildBookMeta() {
  return `title: "从公理生长：智能、世界与 Overseer"
chapters: ${CHAPTER_COUNT}
chars_per_chapter: ${CHARS_PER_CHAPTER}
total_target: ${TOTAL_CHARS_TARGET}
decided_at: ${new Date().toISOString()}
`;
}

export function buildDecisionLog(agiExcerpt) {
  return `# Decision Log

${new Date().toISOString().slice(0, 10)}: Juno 自主选定 M1+A1–A5，20×5000 字结构，启动 axiom-book mission。

AGI input excerpt:
${agiExcerpt.slice(0, 800)}
`;
}

export function runBookDecision(workbench) {
  const dir = missionDir(workbench);
  mkdirSync(path.join(dir, "chapters"), { recursive: true });
  mkdirSync(path.join(dir, "book"), { recursive: true });
  const agiWiki = readOptional(path.join(junoRoot(), "wiki", "juno-agi-north-star.md"));
  const files = {
    "axioms.md": buildAxiomsDoc(),
    "outline.md": buildOutlineDoc(),
    "quality-rubric.md": buildQualityRubric(),
    "book-meta.yaml": buildBookMeta(),
    "decision-log.md": buildDecisionLog(agiWiki),
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, "utf8");
  }
  return Object.keys(files);
}

export function validatePlanningArtifacts(workbench) {
  const dir = missionDir(workbench);
  const required = ["axioms.md", "outline.md", "quality-rubric.md", "book-meta.yaml"];
  const missing = required.filter((f) => !existsSync(path.join(dir, f)));
  if (missing.length) return { ok: false, missing };
  return { ok: true, files: required };
}

export function chapterPath(workbench, chapterNum) {
  return path.join(missionDir(workbench), "chapters", `ch${String(chapterNum).padStart(2, "0")}.md`);
}

export function validateChapter(workbench, chapterNum) {
  const p = chapterPath(workbench, chapterNum);
  if (!existsSync(p)) return { ok: false, reason: `missing ${path.basename(p)}` };
  const han = countHan(readFileSync(p, "utf8"));
  const min = CHARS_PER_CHAPTER - 500;
  const max = CHARS_PER_CHAPTER + 500;
  if (han < min || han > max) return { ok: false, reason: `han=${han} want ${min}-${max}` };
  return { ok: true, han, path: p };
}

export function parseChapterFromPhase(phaseId) {
  const m = phaseId.match(/ch(\d{2})-/);
  return m ? Number(m[1]) : null;
}

export function countBookHan(workbench) {
  let total = 0;
  for (let i = 1; i <= CHAPTER_COUNT; i++) {
    const p = chapterPath(workbench, i);
    if (existsSync(p)) total += countHan(readFileSync(p, "utf8"));
  }
  const merged = path.join(missionDir(workbench), "book", "全书.md");
  if (existsSync(merged)) total = Math.max(total, countHan(readFileSync(merged, "utf8")));
  return total;
}

export function needsLiveAgent(head) {
  const kind = head.run_kind ?? head.kind;
  const phase = head.phase_id ?? "";
  if (kind === "implement" && /ch\d{2}-write/.test(phase)) return true;
  if (kind === "review" && /ch\d{2}-review/.test(phase)) return true;
  if (kind === "implement" && /bq-ch\d{2}-revise|ch\d{2}-revise/.test(phase)) return true;
  if (kind === "review" && /bq-ch\d{2}-review/.test(phase)) return true;
  return false;
}
