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
  loadEvolutionConfig,
  readRunOutcomeMetrics,
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
    expect(snap.components.hardeningTerm).toBe(0);
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

  it("records a real delta and deduplicates identical consecutive ticks", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-evo-delta-"));
    mkdirSync(path.join(dir, "state"), { recursive: true });
    writeFileSync(
      path.join(dir, "state", "evolution-fitness.json"),
      JSON.stringify({ score: 10, autonomyDate: "2026-07-01", components: {}, scoredAt: "x" }),
      "utf8",
    );
    recordEvolutionTick(dir, { trigger: "manual", note: "same" });
    recordEvolutionTick(dir, { trigger: "manual", note: "same" });
    const lines = readFileSync(path.join(dir, "state", "evolution-log.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).delta).toBe(40);
  });

  it("scores terminal run, verify, revise, and safety evidence", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-evo-runs-"));
    const runDir = path.join(dir, "runs", "verify-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ runKind: "verify" }), "utf8");
    writeFileSync(path.join(runDir, "run-state.json"), JSON.stringify({ lastStatus: "done" }), "utf8");
    writeFileSync(path.join(runDir, "checkpoint.md"), "## VERIFY_REPORT\n- tests: PASS\n", "utf8");
    const metrics = readRunOutcomeMetrics(dir);
    expect(metrics.completedRuns).toBe(1);
    expect(metrics.verifyPasses).toBe(1);
    expect(computeEvolutionFitness(dir).score).toBe(95);
  });

  it("does not reward transport done when the run gate is incomplete", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-evo-incomplete-"));
    const runDir = path.join(dir, "runs", "implement-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ runKind: "implement" }), "utf8");
    writeFileSync(path.join(runDir, "run-state.json"), JSON.stringify({ lastStatus: "done" }), "utf8");
    writeFileSync(path.join(runDir, "checkpoint.md"), "STATUS: COMPLETE\n", "utf8");

    const metrics = readRunOutcomeMetrics(dir);
    expect(metrics.completedRuns).toBe(0);
    expect(metrics.failedRuns).toBe(1);
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

  it("migrates legacy activity rewards to v2 outcome-only semantics", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-evo-v2-"));
    mkdirSync(path.join(dir, "config"), { recursive: true });
    writeFileSync(
      path.join(dir, "config", "evolution-unit.json"),
      JSON.stringify({ weights: { hardening: 999, capUtilization: 999 } }),
      "utf8",
    );

    const config = loadEvolutionConfig(dir);
    expect(config.schemaVersion).toBe(2);
    expect(config.weights?.hardening).toBe(0);
    expect(config.weights?.capUtilization).toBe(0);
  });

  it("fails closed on malformed evolution controls", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-evo-invalid-"));
    mkdirSync(path.join(dir, "config"), { recursive: true });
    writeFileSync(path.join(dir, "config", "evolution-unit.json"), "{broken", "utf8");
    expect(() => loadEvolutionConfig(dir)).toThrow(/refusing self-mutation/i);

    writeFileSync(
      path.join(dir, "config", "evolution-unit.json"),
      JSON.stringify({ weights: { runSuccess: "a lot" } }),
      "utf8",
    );
    expect(() => loadEvolutionConfig(dir)).toThrow(/invalid control fields/i);
  });

  it("does not allow blanket orchestrator self-modification", () => {
    expect(isMutationPathAllowed("/wb", "orchestrator/src/review-loop.ts", "juno-overseer")).toBe(false);
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

  it("does not repeat self-optimize during the cooldown window", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-evo-cooldown-"));
    mkdirSync(path.join(dir, "state"), { recursive: true });
    mkdirSync(path.join(dir, "config"), { recursive: true });
    writeFileSync(
      path.join(dir, "config", "evolution-unit.json"),
      JSON.stringify({
        plannerFeedback: {
          declineThresholdDays: 2,
          minDailyScores: 2,
          selfOptimizeCooldownHours: 24,
        },
      }),
      "utf8",
    );
    const entries = [
      { ts: "2026-07-08T00:00:00Z", autonomyDate: "2026-07-08", score: 50, trigger: "manual" },
      { ts: "2026-07-09T00:00:00Z", autonomyDate: "2026-07-09", score: 40, trigger: "manual" },
      { ts: "2026-07-10T00:00:00Z", autonomyDate: "2026-07-10", score: 30, trigger: "manual" },
      {
        ts: new Date().toISOString(),
        autonomyDate: "2026-07-10",
        score: 30,
        trigger: "self_optimize",
      },
    ];
    writeFileSync(
      path.join(dir, "state", "evolution-log.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const decision = shouldSelfOptimizeForFitness(dir);
    expect(decision.yes).toBe(false);
    expect(decision.reason).toContain("cooldown");
  });
});
