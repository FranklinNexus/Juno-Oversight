import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  appendLogEntry,
  bridgePaths,
  completeInboxMission,
  extractBriefBody,
  loadState,
  missionHash,
  parseInboxLines,
  recordEscalation,
  reconcileStaleInProgress,
  refreshStatusBoard,
  resolveMissionId,
  saveState,
} from "../../../scripts/lib/vault-bridge-core.mjs";

describe("vault-bridge-core", () => {
  it("parseInboxLines detects pending vs in-progress vs done", () => {
    const md = [
      "- [ ] task A",
      "- [/] task B <!-- juno:abc123 -->",
      "- [x] task C <!-- juno:def456 done -->",
    ].join("\n");
    const { items } = parseInboxLines(md);
    expect(items[0].pending).toBe(true);
    expect(items[1].inProgress).toBe(true);
    expect(items[2].checked).toBe(true);
  });

  it("completeInboxMission marks [x] only on verify completion", () => {
    const vault = mkdtempSync(path.join(os.tmpdir(), "juno-vb-vault-"));
    const wb = mkdtempSync(path.join(os.tmpdir(), "juno-vb-wb-"));
    mkdirSync(path.join(wb, "state"), { recursive: true });
    writeFileSync(
      path.join(wb, "config.yaml"),
      `vault_path: "${vault.replace(/\\/g, "/")}"\nvault_juno_root: "Juno"\n`,
      "utf8",
    );

    const paths = bridgePaths(wb)!;
    mkdirSync(path.dirname(paths.missionFile), { recursive: true });
    const hash = missionHash("ship feature");
    writeFileSync(
      paths.missionFile,
      `- [/] ship feature <!-- juno:${hash} -->\n`,
      "utf8",
    );
    writeFileSync(paths.logFile, "# Juno Execution Log\n\n", "utf8");

    const state = loadState(paths.stateFile);
    state.byMissionId = { "m-1": { hash, text: "ship feature" } };
    state.byHash = { [hash]: { text: "ship feature", missionId: "m-1", status: "running" } };
    saveState(paths.stateFile, state);

    expect(completeInboxMission(wb, "m-1", [{ repoId: "x", pushed: true, commit: "abc" }])).toBe(
      true,
    );

    const inbox = readFileSync(paths.missionFile, "utf8");
    expect(inbox).toMatch(/- \[x\] ship feature/);
    expect(inbox).toMatch(/done/);

    const log = readFileSync(paths.logFile, "utf8");
    expect(log).toMatch(/mission 完成/);
    expect(log).toMatch(/push=\[x@abc\]/);
  });

  it("appendLogEntry creates daily section", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-vb-log-"));
    const logFile = path.join(dir, "log.md");
    writeFileSync(logFile, "# log\n", "utf8");
    appendLogEntry(logFile, "2026-07-07", "hello");
    const text = readFileSync(logFile, "utf8");
    expect(text).toMatch(/## 2026-07-07/);
    expect(text).toMatch(/hello/);
  });

  it("resolveMissionId reads last-brief-plan when stdout missing", () => {
    const wb = mkdtempSync(path.join(os.tmpdir(), "juno-vb-plan-"));
    mkdirSync(path.join(wb, "state"), { recursive: true });
    const text = "ship the feature";
    writeFileSync(
      path.join(wb, "state", "last-brief-plan.json"),
      `${JSON.stringify({ missionId: "m-ship", sourceText: text })}\n`,
      "utf8",
    );
    expect(resolveMissionId(wb, text, "unknown-abc")).toBe("m-ship");
  });

  it("reconcileStaleInProgress resets orphan [/]", () => {
    const vault = mkdtempSync(path.join(os.tmpdir(), "juno-vb-recon-"));
    const wb = mkdtempSync(path.join(os.tmpdir(), "juno-vb-recon-wb-"));
    mkdirSync(path.join(wb, "state"), { recursive: true });
    writeFileSync(
      path.join(wb, "config.yaml"),
      `vault_path: "${vault.replace(/\\/g, "/")}"\nvault_juno_root: "Juno"\n`,
      "utf8",
    );
    const paths = bridgePaths(wb)!;
    mkdirSync(path.dirname(paths.missionFile), { recursive: true });
    writeFileSync(paths.missionFile, "- [/] orphan task <!-- juno:aaa -->\n", "utf8");
    writeFileSync(paths.logFile, "# log\n\n", "utf8");

    const state = loadState(paths.stateFile);
    const { fixed } = reconcileStaleInProgress(wb, paths, state);
    expect(fixed).toBeGreaterThan(0);
    const inbox = readFileSync(paths.missionFile, "utf8");
    expect(inbox).toMatch(/- \[ \] orphan task/);
  });

  it("recordEscalation writes Human_Escalations", () => {
    const vault = mkdtempSync(path.join(os.tmpdir(), "juno-vb-esc-"));
    const wb = mkdtempSync(path.join(os.tmpdir(), "juno-vb-esc-wb-"));
    mkdirSync(path.join(wb, "state"), { recursive: true });
    writeFileSync(
      path.join(wb, "config.yaml"),
      `vault_path: "${vault.replace(/\\/g, "/")}"\nvault_juno_root: "Juno"\n`,
      "utf8",
    );
    const paths = bridgePaths(wb)!;
    mkdirSync(path.dirname(paths.escalationsFile), { recursive: true });
    writeFileSync(paths.escalationsFile, "# Human Escalations\n\n", "utf8");
    writeFileSync(paths.logFile, "# log\n\n", "utf8");

    expect(recordEscalation(wb, { kind: "test", reason: "unit", missionId: "m-1" })).toBe(true);
    const esc = readFileSync(paths.escalationsFile, "utf8");
    expect(esc).toMatch(/test/);
    expect(esc).toMatch(/m-1/);
  });

  it("refreshStatusBoard writes queue head", () => {
    const vault = mkdtempSync(path.join(os.tmpdir(), "juno-vb-st-"));
    const wb = mkdtempSync(path.join(os.tmpdir(), "juno-vb-st-wb-"));
    mkdirSync(path.join(wb, "state"), { recursive: true });
    mkdirSync(path.join(wb, "queue"), { recursive: true });
    writeFileSync(
      path.join(wb, "config.yaml"),
      `vault_path: "${vault.replace(/\\/g, "/")}"\nvault_juno_root: "Juno"\n`,
      "utf8",
    );
    writeFileSync(
      path.join(wb, "queue/now.yaml"),
      `updated: now\nnow:\n  - id: run-1\n    mission_id: m-1\n    phase_id: p1\n    run_kind: implement\nbacklog:\n  []\n`,
      "utf8",
    );
    writeFileSync(
      path.join(wb, "state", "drive-engine.json"),
      JSON.stringify({
        driveStrategy: "lrif",
        lastScanAt: "2026-07-07T00:00:00.000Z",
        lastTopHypothesis: "h1",
        lastTopMissionId: "juno-daily-inbox-2026",
      }),
      "utf8",
    );
    const paths = bridgePaths(wb)!;
    refreshStatusBoard(wb);
    const status = readFileSync(paths.statusFile, "utf8");
    expect(status).toMatch(/run-1/);
    expect(status).toMatch(/m-1/);
    expect(status).toMatch(/drive strategy \| lrif/);
    expect(status).toMatch(/Top proposal：h1/);
  });

  it("extractBriefBody ignores placeholder-only body", () => {
    const md = "# t\n\n---\n\n（在下方写你的任务）\n";
    expect(extractBriefBody(md)).toBe("");
  });
});
