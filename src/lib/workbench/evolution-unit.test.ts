import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  computeEvolutionFitness,
  countHardeningPhasesDone,
  isMutationPathAllowed,
  recordEvolutionTick,
  evaluateEvolutionFeedback,
  shouldSelfOptimizeForFitness,
  dailyScoresFromLog,
} from "../../../orchestrator/src/evolution-unit.js";

describe("evolution-unit", () => {
  it("computes fitness from quality scan and hardening progress", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-evo-"));
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(
      path.join(dir, "state", "quality-scan.json"),
      `${JSON.stringify({ failedChapters: [16] })}\n`,
      "utf8",
    );
    mkdirSync(path.join(dir, "missions", "juno-overseer-hardening-2026"), { recursive: true });
    writeFileSync(
      path.join(dir, "missions", "juno-overseer-hardening-2026", "progress.md"),
      "| h01 | implement | done |\n| h02 | review | done |\n",
      "utf8",
    );
    const snap = computeEvolutionFitness(dir);
    expect(snap.components.failedChapters).toBe(1);
    expect(snap.components.hardeningPhasesDone).toBe(2);
    expect(snap.components.bookQualityTerm).toBe(-10);
    expect(snap.components.hardeningTerm).toBe(10);
  });

  it("records evolution log entry", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-evo-log-"));
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(path.join(dir, "state", "quality-scan.json"), '{"failedChapters":[]}\n', "utf8");
    recordEvolutionTick(dir, { trigger: "manual", note: "test" });
    expect(existsSync(path.join(dir, "state", "evolution-log.jsonl"))).toBe(true);
    const line = readFileSync(path.join(dir, "state", "evolution-log.jsonl"), "utf8").trim();
    const entry = JSON.parse(line);
    expect(entry.trigger).toBe("manual");
    expect(typeof entry.score).toBe("number");
  });

  it("counts hardening done rows from progress table only", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-evo-hard-"));
    mkdirSync(path.join(dir, "missions", "juno-overseer-hardening-2026"), { recursive: true });
    writeFileSync(
      path.join(dir, "missions", "juno-overseer-hardening-2026", "progress.md"),
      `# Progress\n\n| Phase | Kind | Status |\n|-------|------|--------|\n| h01 | implement | done |\n| h02 | review | queued |\n| h03 | implement | done |\n`,
      "utf8",
    );
    expect(countHardeningPhasesDone(dir)).toBe(2);
  });

  it("applies idle penalty when requested", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-evo-idle-"));
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(path.join(dir, "state", "quality-scan.json"), '{"failedChapters":[]}\n', "utf8");
    const idle = computeEvolutionFitness(dir, { idlePenaltyCount: 1 });
    const active = computeEvolutionFitness(dir, { idlePenaltyCount: 0 });
    expect(idle.components.idlePenalty).toBe(-3);
    expect(idle.score).toBeLessThan(active.score);
  });

  it("allows model-defaults in mutation allowlist", () => {
    expect(isMutationPathAllowed("/wb", "config/model-defaults.json")).toBe(true);
  });

  it("denies charter mutation path", () => {
    expect(isMutationPathAllowed("/wb", "E:/AgentWorkbench/config/autonomy-charter.json")).toBe(false);
    expect(isMutationPathAllowed("/wb", "missions/juno-axiom-book-2026/quality-rubric.md")).toBe(true);
  });

  it("detects declining fitness from evolution log", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-evo-decline-"));
    mkdirSync(path.join(dir, "state"), { recursive: true });
    mkdirSync(path.join(dir, "config"), { recursive: true });
    writeFileSync(
      path.join(dir, "config", "evolution-unit.json"),
      JSON.stringify({ plannerFeedback: { declineThresholdDays: 3, minDailyScores: 2 } }),
      "utf8",
    );
    const lines = [
      { ts: "2026-07-01T00:00:00Z", autonomyDate: "2026-07-01", score: 50, trigger: "manual" },
      { ts: "2026-07-02T00:00:00Z", autonomyDate: "2026-07-02", score: 40, trigger: "manual" },
      { ts: "2026-07-03T00:00:00Z", autonomyDate: "2026-07-03", score: 30, trigger: "manual" },
    ];
    writeFileSync(
      path.join(dir, "state", "evolution-log.jsonl"),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      "utf8",
    );
    expect(dailyScoresFromLog(dir)).toHaveLength(3);
    const fb = evaluateEvolutionFeedback(dir);
    expect(fb.trend).toBe("ok");
    expect(fb.consecutiveDeclineDays).toBe(2);
    expect(shouldSelfOptimizeForFitness(dir).yes).toBe(false);
    lines.push({
      ts: "2026-07-04T00:00:00Z",
      autonomyDate: "2026-07-04",
      score: 20,
      trigger: "manual",
    });
    writeFileSync(
      path.join(dir, "state", "evolution-log.jsonl"),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      "utf8",
    );
    expect(shouldSelfOptimizeForFitness(dir).yes).toBe(true);
  });
});
