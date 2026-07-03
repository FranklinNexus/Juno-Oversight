import { describe, expect, it } from "vitest";
import {
  formatPromotePreviewSummary,
  type PromotePreview,
} from "@/lib/workbench/orchestrator-client";

const samplePreview: PromotePreview = {
  sourcePath: "E:\\AgentWorkbench\\staging\\jinstone\\note.md",
  destPath: "E:\\Obsidian Vault\\20_Projects\\note.md",
  action: "create",
  sourceBytes: 120,
  destBytes: null,
  sourceLines: 8,
  destLines: null,
  linesAdded: 8,
  linesRemoved: 0,
  willAddFrontmatter: true,
  diffLines: ["+ line one", "+ line two"],
  summary: "new file → E:\\Obsidian Vault\\20_Projects\\note.md (8 lines, 120 bytes)",
};

describe("formatPromotePreviewSummary", () => {
  it("includes action, summary, meta, and diff lines", () => {
    const text = formatPromotePreviewSummary(samplePreview);
    expect(text).toContain("[CREATE]");
    expect(text).toContain("frontmatter: will inject");
    expect(text).toContain("+ line one");
    expect(text).toContain(samplePreview.summary);
  });

  it("shows unchanged placeholder when diff empty", () => {
    const text = formatPromotePreviewSummary({
      ...samplePreview,
      action: "unchanged",
      diffLines: [],
    });
    expect(text).toContain("(no diff — unchanged)");
  });
});
