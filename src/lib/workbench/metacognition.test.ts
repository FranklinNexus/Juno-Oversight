import { describe, expect, it } from "vitest";
import {
  parseMetacognition,
  validateMetacognitionForAdvance,
  buildMetacognitionPromptBlock,
} from "../../../orchestrator/src/metacognition.js";

const sampleMeta = `
## METACOGNITION
- understood: partial
- understanding_gaps: ["scope edge case"]
- reviewed: yes
- review_depth: adequate
- new_angles: ["could use lazy import instead"]
- should_revisit: false
- confidence: 0.7
- notes: looked at diff
`;

const sampleReviewPass = `
${sampleMeta}
## REVIEW_VERDICT
- verdict: PASS
- drift: none
- scope_violations: []
- must_fix_next_slot: []
`;

describe("metacognition", () => {
  it("parses METACOGNITION block", () => {
    const m = parseMetacognition(sampleMeta);
    expect(m?.understood).toBe("partial");
    expect(m?.reviewed).toBe("yes");
    expect(m?.newAngles.length).toBe(1);
  });

  it("blocks review advance without METACOGNITION", () => {
    const r = validateMetacognitionForAdvance(
      "review",
      "## REVIEW_VERDICT\n- verdict: PASS",
      "E:\\AgentWorkbench",
    );
    expect(r.ok).toBe(false);
  });

  it("allows review with valid METACOGNITION", () => {
    const r = validateMetacognitionForAdvance("review", sampleReviewPass, "E:\\AgentWorkbench");
    expect(r.ok).toBe(true);
  });

  it("includes self-questions in prompt block", () => {
    const block = buildMetacognitionPromptBlock("review");
    expect(block).toContain("想明白了吗");
    expect(block).toContain("METACOGNITION");
  });
});
