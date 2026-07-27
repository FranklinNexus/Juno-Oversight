import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseExecutionOutcomeMetrics, updateWeeklyKpi } from "../../../scripts/lib/kpi-weekly.mjs";

describe("kpi-weekly", () => {
  it("derives delivery and quality metrics from persisted gate outcomes", () => {
    const metrics = parseExecutionOutcomeMetrics(
      [
        "## 2026-07-07",
        "- 2026-07-07T09:00:00Z ✅ implement PASS `m1`",
        "- 2026-07-07T09:01:00Z 🔄 review REVISE `m1`",
        "- 2026-07-07T09:02:00Z ✅ review PASS `m1`",
        "- 2026-07-07T09:03:00Z ✅ verify PASS `m1`",
        "- 2026-07-07T09:04:00Z 🏁 mission 完成 `m1`",
        "## 2026-07-08",
        "- 2026-07-08T09:00:00Z ❌ verify FAIL `m2`",
      ].join("\n"),
      "2026-07-07",
    );

    expect(metrics.missionDone).toBe(1);
    expect(metrics.verifyPass).toBe(1);
    expect(metrics.reviewRework).toBe(1);
    expect(metrics.verifyPassRate).toBe(1);
    expect(metrics.reworkRate).toBe(0.5);
  });

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
    writeFileSync(
      path.join(vault, "Juno", "Juno_Execution_Log.md"),
      [
        "# Execution Log",
        "",
        "## 2026-07-07",
        "",
        "- 2026-07-07T09:00:00Z ✅ implement PASS `m1`",
        "- 2026-07-07T09:01:00Z 🔄 review REVISE `m1`",
        "- 2026-07-07T09:02:00Z ✅ review PASS `m1`",
        "- 2026-07-07T09:03:00Z ✅ verify PASS `m1`",
        "- 2026-07-07T09:04:00Z 🏁 mission 完成 `m1`",
        "",
      ].join("\n"),
    );

    const result = updateWeeklyKpi(wb, "2026-07-07");
    expect(result.ok).toBe(true);
    const kpi = readFileSync(path.join(vault, "Juno", "KPI_Weekly.md"), "utf8");
    expect(kpi).toMatch(/2026-07-07/);
    expect(kpi).toMatch(/\| 7 \| no \| 2 \| lrif \|/);
    expect(kpi).toMatch(/\| 1 \| 1 \| 1 \| 0 \| 100% \| 50% \|/);

    const json = JSON.parse(readFileSync(path.join(vault, "Juno", "KPI_Weekly.json"), "utf8"));
    expect(json.latest.missionDone).toBe(1);
    expect(json.latest.verifyPassRate).toBe(1);
    expect(json.latest.reworkRate).toBe(0.5);

    const state = JSON.parse(readFileSync(path.join(wb, "state", "kpi-latest.json"), "utf8"));
    expect(state.latest).toEqual(json.latest);
  });
});
