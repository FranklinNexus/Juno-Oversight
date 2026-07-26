import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveAgentModel,
  resolveAgentProvider,
} from "../../../orchestrator/src/model-defaults.js";

describe("model-defaults provider routing", () => {
  it("defaults to Codex and canonicalizes the legacy Cursor identifier", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-provider-default-"));
    expect(resolveAgentProvider(workbench)).toBe("openai_codex");
    expect(resolveAgentProvider(workbench, "cursor_composer")).toBe("openai_codex");
  });

  it("routes legacy Cursor queue items to an explicitly configured Codex provider", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-provider-alias-"));
    mkdirSync(path.join(workbench, "config"), { recursive: true });
    writeFileSync(
      path.join(workbench, "config", "model-defaults.json"),
      JSON.stringify({
        defaultProvider: "openai_codex",
        providerAliases: { cursor_composer: "openai_codex" },
      }),
      "utf8",
    );

    expect(resolveAgentProvider(workbench)).toBe("openai_codex");
    expect(resolveAgentProvider(workbench, "cursor_composer")).toBe("openai_codex");
  });

  it("rejects aliases back to the removed executor and strips Composer model ids", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-provider-fail-safe-"));
    mkdirSync(path.join(workbench, "config"), { recursive: true });
    writeFileSync(
      path.join(workbench, "config", "model-defaults.json"),
      JSON.stringify({
        defaultProvider: "cursor_composer",
        providerAliases: { cursor_composer: "cursor_composer" },
      }),
      "utf8",
    );
    expect(resolveAgentProvider(workbench)).toBe("openai_codex");
    expect(resolveAgentModel("openai_codex", "composer-2.5")).toBeUndefined();
    expect(resolveAgentModel("openai_codex", "gpt-5.4")).toBe("gpt-5.4");
  });
});
