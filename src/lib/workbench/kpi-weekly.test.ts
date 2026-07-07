import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { updateWeeklyKpi } from "../../../scripts/lib/kpi-weekly.mjs";

describe("kpi-weekly", () => {
  it("writes or updates a daily KPI row", () => {
    const wb = mkdtempSync(path.join(tmpdir(), "juno-kpi-wb-"));
    const vault = mkdtempSync(path.join(tmpdir(), "juno-kpi-vault-"));
    mkdirSync(path.join(wb, "state"), { recursive: true });
    mkdirSync(path.join(wb, "queue"), { recursive: true });
    writeFileSync(path.join(wb, "config.yaml"), `vault_path: "${vault}"\nvault_juno_root: "Juno"\n`);
    writeFileSync(path.join(wb, "state", "daily-juno.json"), JSON.stringify({ ticks: 7, capFilled: false }));
    writeFileSync(
      path.join(wb, "state", "drive-engine.json"),
      JSON.stringify({ driveStrategy: "lrif", lastTopMissionId: "juno-daily-inbox-2026" }),
    );
    writeFileSync(path.join(wb, "state", "mission-planner.json"), JSON.stringify({ decision: { action: "run_generic_loop" } }));
    writeFileSync(path.join(wb, "queue", "now.yaml"), "updated: x\nnow:\n  - id: r1\nbacklog:\n  []\n");
    mkdirSync(path.join(vault, "Juno"), { recursive: true });
    writeFileSync(
      path.join(vault, "Juno", "Human_Escalations.md"),
      "# Human Escalations\n\n## 2026-07-07\n\n- e1\n- e2\n",
    );

    const result = updateWeeklyKpi(wb, "2026-07-07");
    expect(result.ok).toBe(true);
    const kpi = readFileSync(path.join(vault, "Juno", "KPI_Weekly.md"), "utf8");
    expect(kpi).toMatch(/2026-07-07/);
    expect(kpi).toMatch(/\| 7 \| no \| 2 \| lrif \|/);
  });
});
