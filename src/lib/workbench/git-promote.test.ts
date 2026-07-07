import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  repoEligibleForMission,
  tryGitPromoteForRepo,
} from "../../../orchestrator/src/git-promote.js";

function initRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "t@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "pipe" });
}

describe("git-promote", () => {
  it("repoEligibleForMission requires allowlist unless allowAllMissions", () => {
    expect(repoEligibleForMission({ id: "x", root: "/tmp" }, "m1", false)).toEqual({
      ok: false,
      reason: "repo has no mission allowlist",
    });
    expect(
      repoEligibleForMission(
        { id: "x", root: "/tmp", allowAllMissions: true },
        "m1",
        false,
      ).ok,
    ).toBe(true);
    expect(
      repoEligibleForMission(
        { id: "x", root: "/tmp", missions: ["m1"] },
        "m2",
        false,
      ).reason,
    ).toBe("mission not in repo allowlist");
  });

  it("tryGitPromoteForRepo only stages pathPrefixes", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "juno-git-prom-"));
    initRepo(dir);
    mkdirSync(path.join(dir, "orchestrator"), { recursive: true });
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "orchestrator", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(path.join(dir, "src", "noise.ts"), "export const n = 1;\n", "utf8");
    execSync("git add .", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
    writeFileSync(path.join(dir, "orchestrator", "a.ts"), "export const a = 2;\n", "utf8");
    writeFileSync(path.join(dir, "src", "noise.ts"), "export const n = 2;\n", "utf8");

    const r = tryGitPromoteForRepo(dir, {
      message: "scoped",
      pathPrefixes: ["orchestrator/"],
    });
    expect(r.commit ?? r.pushed).toBeTruthy();
    const log = execSync("git log -1 --name-only", { cwd: dir, encoding: "utf8" });
    expect(log).toMatch(/scoped/);
    expect(log).toMatch(/orchestrator[\\/]a\.ts/);
    expect(log).not.toMatch(/src[\\/]noise\.ts/);
    const status = execSync("git status --porcelain", { cwd: dir, encoding: "utf8" });
    expect(status).toMatch(/src\/noise\.ts/);
  });
});
