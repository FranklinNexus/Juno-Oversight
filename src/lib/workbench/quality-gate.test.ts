import { describe, expect, it } from "vitest";
import {
  countSpacedBoldArtifacts,
  fixSpacedBoldInText,
  validateChapterText,
} from "../../../orchestrator/src/quality-gate.js";

describe("quality-gate", () => {
  it("fixes spaced-bold artifacts programmatically", () => {
    const bad = "正常段落。** ** **债务** ** **关系** ** **未** ** **闭合**。";
    const { text, fixesApplied } = fixSpacedBoldInText(bad);
    expect(fixesApplied).toBeGreaterThan(0);
    expect(countSpacedBoldArtifacts(text)).toBe(0);
    expect(text).toContain("债务");
    expect(text).toContain("未");
    expect(text).not.toMatch(/\*\*\s+\*\*/);
  });

  it("detects spaced-bold artifacts", () => {
    const bad = "正常段落。** ** **债务** ** **关系** ** **未** ** **闭合**。";
    expect(countSpacedBoldArtifacts(bad)).toBeGreaterThanOrEqual(2);
    const report = validateChapterText(
      `# 第18章 测试\n\n**相关公理**：M1\n\n** ** **词** ** **间** ** **插** ** **空** **。\n\n本书主张：测试。`,
      18,
      { strictLength: false },
    );
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "spaced_bold")).toBe(true);
  });

  it("passes clean chapter sample", () => {
    const good = `# 第01章 测试

**相关公理**：M1

正文论证与思想实验。

**本书主张：** 测试主张可 refute。`;
    const report = validateChapterText(good, 1, { strictLength: false });
    expect(report.ok).toBe(true);
  });
});
