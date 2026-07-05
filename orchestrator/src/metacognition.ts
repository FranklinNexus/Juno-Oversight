/**
 * Metacognition v1 — Juno asks itself before advancing:
 * understood? reviewed? new angles?
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RunKind } from "./types.js";

export type MetacognitionUnderstanding = "yes" | "partial" | "no";
export type MetacognitionReviewDepth = "shallow" | "adequate" | "deep";

export interface MetacognitionConfig {
  enabled?: boolean;
  /** Review PASS requires ## METACOGNITION with reviewed: yes */
  requireOnReviewPass?: boolean;
  /** Implement STATUS: COMPLETE requires METACOGNITION block */
  requireOnImplementComplete?: boolean;
  /** Min new_angles entries on review PASS */
  minNewAnglesOnReview?: number;
}

export interface ParsedMetacognition {
  understood: MetacognitionUnderstanding;
  understandingGaps: string[];
  reviewed: "yes" | "no";
  reviewDepth?: MetacognitionReviewDepth;
  newAngles: string[];
  shouldRevisit: boolean;
  confidence: number;
  notes?: string;
}

export const DEFAULT_METACOGNITION_QUESTIONS: Record<RunKind | "drive", string[]> = {
  implement: [
    "我真正理解 north-star、scope 和创始人目标了吗？还有哪些 gap？",
    "这个实现是最佳角度，还是只是第一个能跑通的方案？",
    "如果 REVIEW 来挑刺，最可能漏掉什么？",
  ],
  review: [
    "Implementer 想明白了吗，还是只做了表面？我有没有核实 CHANGES？",
    "我的 review 够深了吗？有没有偷懒给 PASS？",
    "有没有新角度、风险、或 must_fix 被遗漏？",
  ],
  verify: [
    "测试 PASS 是否覆盖真实风险？有没有「绿但语义错」？",
    "verify 之后还需要人类或下一轮 review 吗？",
  ],
  debate: [
    "双方论点是否都理解了？有没有未探索的第三选项？",
  ],
  vote: [
    "投票依据是否充分？有没有被忽略的 dissent angle？",
  ],
  drive: [
    "当前选择真正服务于 constitution 和创始人目标吗？",
    "我是在机械执行 queue，还是更新了理解？",
    "有什么值得单独 spawn 的新 angle / research brief？",
  ],
};

function configPath(workbench: string): string {
  return path.join(workbench, "config", "metacognition.json");
}

export function loadMetacognitionConfig(workbench: string): MetacognitionConfig {
  const p = configPath(workbench);
  if (!existsSync(p)) {
    return {
      enabled: true,
      requireOnReviewPass: true,
      requireOnImplementComplete: false,
      minNewAnglesOnReview: 1,
    };
  }
  try {
    return JSON.parse(readFileSync(p, "utf8")) as MetacognitionConfig;
  } catch {
    return { enabled: true, requireOnReviewPass: true, minNewAnglesOnReview: 1 };
  }
}

function extractSection(checkpointText: string): string | null {
  const match = checkpointText.match(/##\s*METACOGNITION[\s\S]*?(?=\n##\s|$)/i);
  return match?.[0] ?? null;
}

function parseListField(section: string, field: string): string[] {
  const match = section.match(new RegExp(`${field}:\\s*(\\[[^\\]]*\\])`, "i"));
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1].replace(/'/g, '"')) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    const inner = match[1].slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
}

function parseYesNo(section: string, field: string): "yes" | "no" | undefined {
  const m = section.match(new RegExp(`${field}:\\s*(yes|no)`, "i"));
  return m ? (m[1].toLowerCase() as "yes" | "no") : undefined;
}

export function parseMetacognition(checkpointText: string): ParsedMetacognition | null {
  const section = extractSection(checkpointText);
  if (!section) return null;

  const understoodMatch = section.match(/understood:\s*(yes|partial|no)/i);
  const depthMatch = section.match(/review_depth:\s*(shallow|adequate|deep)/i);
  const revisitMatch = section.match(/should_revisit:\s*(true|false)/i);
  const confMatch = section.match(/confidence:\s*([\d.]+)/i);
  const notesMatch = section.match(/notes:\s*(.+)$/im);

  const reviewed = parseYesNo(section, "reviewed");
  if (!understoodMatch || !reviewed) return null;

  return {
    understood: understoodMatch[1].toLowerCase() as MetacognitionUnderstanding,
    understandingGaps: parseListField(section, "understanding_gaps"),
    reviewed,
    reviewDepth: depthMatch?.[1]?.toLowerCase() as MetacognitionReviewDepth | undefined,
    newAngles: parseListField(section, "new_angles"),
    shouldRevisit: revisitMatch?.[1] === "true",
    confidence: confMatch ? Math.min(1, Math.max(0, Number(confMatch[1]))) : 0.5,
    notes: notesMatch?.[1]?.trim(),
  };
}

export function metacognitionTemplate(runKind: RunKind | "drive"): string {
  return `## METACOGNITION
- understood: yes|partial|no
- understanding_gaps: []
- reviewed: yes|no
- review_depth: shallow|adequate|deep
- new_angles: ["至少写 1 个可能更好的角度或风险"]
- should_revisit: true|false
- confidence: 0.0-1.0
- notes: （简短诚实自述：想明白了吗？review 了吗？）`;
}

export function buildMetacognitionPromptBlock(
  runKind: RunKind | "drive",
  workbench?: string,
): string {
  const cfg = workbench ? loadMetacognitionConfig(workbench) : { enabled: true };
  if (cfg.enabled === false) return "";

  const questions = DEFAULT_METACOGNITION_QUESTIONS[runKind] ?? DEFAULT_METACOGNITION_QUESTIONS.implement;
  const lines = [
    "## 元认知自问（Juno 必须诚实回答，不可跳过）",
    "",
    "在写 checkpoint 之前，先问自己：",
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    "将答案写入 checkpoint 的 **METACOGNITION** 段（与 REVIEW_VERDICT / CHANGES 同级）：",
    "",
    "```markdown",
    metacognitionTemplate(runKind),
    "```",
    "",
    "**规则**：",
    "- Review slot：无 METACOGNITION → 视为 review 未完成，不得 PASS",
    "- Implement slot：understood=partial|no 时应在 understanding_gaps 列出缺口",
    "- new_angles 不能为空泛话；必须是具体可行动的 alternative",
    "",
  ];
  return lines.join("\n");
}

export function validateMetacognitionForAdvance(
  runKind: RunKind,
  checkpointText: string,
  workbench: string,
): { ok: true } | { ok: false; reason: string } {
  const cfg = loadMetacognitionConfig(workbench);
  if (cfg.enabled === false) return { ok: true };

  const meta = parseMetacognition(checkpointText);
  if (!meta) {
    if (runKind === "review" && cfg.requireOnReviewPass !== false) {
      return { ok: false, reason: "missing METACOGNITION section on review slot" };
    }
    if (runKind === "implement" && cfg.requireOnImplementComplete === true) {
      return { ok: false, reason: "missing METACOGNITION section on implement slot" };
    }
    return { ok: true };
  }

  if (runKind === "review" && cfg.requireOnReviewPass !== false) {
    if (meta.reviewed !== "yes") {
      return { ok: false, reason: "METACOGNITION reviewed must be yes before REVIEW PASS" };
    }
    const minAngles = cfg.minNewAnglesOnReview ?? 1;
    if (meta.newAngles.length < minAngles) {
      return {
        ok: false,
        reason: `METACOGNITION needs >= ${minAngles} new_angles before review PASS`,
      };
    }
    if (meta.understood === "no") {
      return { ok: false, reason: "METACOGNITION understood:no — REVISE or deepen review" };
    }
  }

  return { ok: true };
}

export function buildDriveMetacognitionSummary(
  observations: Array<{ kind: string; summary: string }>,
  topProposalHypothesis?: string,
): string[] {
  const lines: string[] = [
    "Juno 自问（drive tick）：",
    "1. 我选对 mission 了吗？还是惯性 queue？",
    "2. 对创始人目标的理解更新了吗？",
    "3. 有没有该 spawn 却还没试的新 angle？",
  ];
  if (topProposalHypothesis) {
    lines.push(`→ 当前倾向：${topProposalHypothesis}`);
  }
  const gaps = observations.filter((o) => o.kind === "ambition_gap" || o.kind === "research_gap");
  if (gaps.length) {
    lines.push(`→ 仍 open 的 gap：${gaps.slice(0, 3).map((g) => g.summary).join("; ")}`);
  }
  return lines;
}
