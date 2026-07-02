import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateExportRoot, runDailyExport } from "../../../orchestrator/src/daily-export.js";

describe("daily-export", () => {
  it("rejects vault and workbench as export root", () => {
    const wb = mkdtempSync(path.join(os.tmpdir(), "juno-exp-"));
    const vault = mkdtempSync(path.join(os.tmpdir(), "juno-vault-"));

    expect(validateExportRoot(wb, { workbenchRoot: wb }).ok).toBe(false);
    expect(validateExportRoot(vault, { workbenchRoot: wb, vaultPath: vault }).ok).toBe(false);
    expect(
      validateExportRoot("E:\\JunoDailyExport", { workbenchRoot: wb, vaultPath: vault }).ok,
    ).toBe(true);
  });

  it("exports digest and mission copies to isolated dir", () => {
    const wb = mkdtempSync(path.join(os.tmpdir(), "juno-exp-wb-"));
    const exportRoot = mkdtempSync(path.join(os.tmpdir(), "juno-exp-out-"));

    mkdirSync(path.join(wb, "config"), { recursive: true });
    writeFileSync(
      path.join(wb, "config", "daily-schedule.json"),
      JSON.stringify({ exportRoot, exportObsidianBundle: true }),
      "utf8",
    );
    mkdirSync(path.join(wb, "missions", "juno-test-2026"), { recursive: true });
    writeFileSync(path.join(wb, "missions", "juno-test-2026", "progress.md"), "| p | done |", "utf8");
    mkdirSync(path.join(wb, "state"), { recursive: true });
    writeFileSync(
      path.join(wb, "state", "bounded-autonomy.json"),
      JSON.stringify({ date: "2026-07-03", iterationsToday: 12 }),
      "utf8",
    );

    const result = runDailyExport(wb, { date: "2026-07-03" });
    expect(result.errors).toHaveLength(0);
    expect(existsSync(result.digestPath)).toBe(true);
    expect(result.copiedFiles.some((f) => f.includes("progress.md"))).toBe(true);
    expect(result.exportDir.startsWith(exportRoot)).toBe(true);
  });
});
