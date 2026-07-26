import { describe, expect, it } from "vitest";
import { resolveAgentExecutor } from "../../../orchestrator/src/executor.js";

describe("agent executor registry", () => {
  it("selects registered providers and rejects the text-only api token path", async () => {
    const codex = async () => ({ ok: true, text: "ok" });
    expect(resolveAgentExecutor("openai_codex", { openai_codex: codex })).toBe(codex);
    expect(() => resolveAgentExecutor("api_token", {})).toThrow(/text-only/);
    expect(() => resolveAgentExecutor("cursor_composer", {})).toThrow(/legacy queue identifier/);
  });
});
