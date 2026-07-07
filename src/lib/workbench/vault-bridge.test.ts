import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  appendLogEntry,
  bridgePaths,
  completeInboxMission,
  loadState,
  missionHash,
  parseInboxLines,
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
});
