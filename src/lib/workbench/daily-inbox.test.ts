import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateDailyInbox, renderDailyInboxDate } from "../../../orchestrator/src/daily-inbox.js";

describe("daily-inbox", () => {
  it("creates today's file under Vault Juno inbox", () => {
    const vault = mkdtempSync(path.join(tmpdir(), "juno-vault-"));
    const wb = mkdtempSync(path.join(tmpdir(), "juno-wb-"));
    mkdirSync(path.join(wb, "config"), { recursive: true });
    writeFileSync(path.join(wb, "config.yaml"), `vault_path: "${vault}"\nvault_juno_root: "Juno"\n`);
    writeFileSync(path.join(wb, "config", "daily-inbox.json"), JSON.stringify({ enabled: true }));
    mkdirSync(path.join(vault, "Juno", "inbox"), { recursive: true });
    writeFileSync(path.join(vault, "Juno", "inbox", "_profile.md"), "## 当前重心\n\n- Juno Runtime 产品化\n");

    const result = generateDailyInbox(wb, "2026-07-07");
    expect(result.status).toBe("created");
    expect(result.filePath).toContain(path.join("Juno", "inbox"));

    const text = readFileSync(result.filePath!, "utf8");
    expect(text).toMatch("2026-07-07 每日任务");
    expect(text).toMatch("给你的三件事");
  });

  it("skips duplicate generation on same day", () => {
    const vault = mkdtempSync(path.join(tmpdir(), "juno-vault-"));
    const wb = mkdtempSync(path.join(tmpdir(), "juno-wb-"));
    mkdirSync(path.join(wb, "config"), { recursive: true });
    writeFileSync(path.join(wb, "config.yaml"), `vault_path: "${vault}"\nvault_juno_root: "Juno"\n`);
    mkdirSync(path.join(vault, "Juno", "inbox"), { recursive: true });
    writeFileSync(path.join(vault, "Juno", "inbox", "_profile.md"), "## 当前重心\n\n- 投资研究 LRIF\n");

    const first = generateDailyInbox(wb, "2026-07-08");
    const second = generateDailyInbox(wb, "2026-07-08");
    expect(first.status).toBe("created");
    expect(second.status).toBe("skipped");
  });

  it("deletes yesterday file when configured", () => {
    const vault = mkdtempSync(path.join(tmpdir(), "juno-vault-"));
    const wb = mkdtempSync(path.join(tmpdir(), "juno-wb-"));
    mkdirSync(path.join(wb, "config"), { recursive: true });
    writeFileSync(path.join(wb, "config.yaml"), `vault_path: "${vault}"\nvault_juno_root: "Juno"\n`);
    writeFileSync(
      path.join(wb, "config", "daily-inbox.json"),
      JSON.stringify({ enabled: true, deletePreviousDay: true }),
    );
    const inboxDir = path.join(vault, "Juno", "inbox");
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(path.join(inboxDir, "_profile.md"), "## 当前重心\n\n- Juno Runtime 产品化\n");
    writeFileSync(path.join(inboxDir, "2026-07-06-每日任务.md"), "old");

    const result = generateDailyInbox(wb, "2026-07-07");
    expect(result.status).toBe("created");
    expect((result.deleted ?? []).some((p) => p.endsWith("2026-07-06-每日任务.md"))).toBe(true);
  });

  it("date helper returns YYYY-MM-DD", () => {
    expect(renderDailyInboxDate(new Date("2026-07-07T12:00:00Z"))).toBe("2026-07-07");
  });
});
