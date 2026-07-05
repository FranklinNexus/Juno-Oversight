import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  alignmentBoostForMission,
  loadFounderContext,
} from "../../../orchestrator/src/founder-context.js";

describe("founder-context", () => {
  it("parses 当前重心 and matches themes", () => {
    const wb = mkdtempSync(path.join(tmpdir(), "juno-founder-"));
    mkdirSync(path.join(wb, "config"), { recursive: true });
    writeFileSync(
      path.join(wb, "config.yaml"),
      'vault_path: "E:/Obsidian Vault"\nvault_juno_root: "Juno"\n',
    );
    writeFileSync(
      path.join(wb, "config", "founder-alignment.json"),
      JSON.stringify({
        themes: [
          {
            id: "juno-product",
            label: "Juno",
            keywords: ["juno", "runtime"],
            missions: ["juno-wisdomechoes-axiom-blog-2026"],
          },
          {
            id: "investment",
            label: "投资",
            keywords: ["投资", "lrif"],
            missions: ["juno-daily-inbox-2026"],
          },
        ],
      }),
    );
    const inbox = path.join("E:", "Obsidian Vault", "Juno", "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      path.join(inbox, "_profile.md"),
      "## 当前重心\n\n- Juno Runtime 产品化\n- 投资研究 LRIF\n",
    );

    const ctx = loadFounderContext(wb);
    expect(ctx.currentFocus.length).toBeGreaterThanOrEqual(2);
    expect(ctx.activeThemes.some((t) => t.id === "juno-product")).toBe(true);
    expect(ctx.activeThemes.some((t) => t.id === "investment")).toBe(true);
    expect(alignmentBoostForMission("juno-wisdomechoes-axiom-blog-2026", ctx)).toBeGreaterThan(0);
  });
});
