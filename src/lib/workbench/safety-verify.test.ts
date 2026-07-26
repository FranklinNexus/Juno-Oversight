import { describe, expect, it } from "vitest";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ensureMissionSafetyBaseline,
  missionSafetyBaselinePath,
  runMissionDiffSafetyVerify,
  runSafetyVerifyBundle,
  scanTextForDestructiveCommands,
  scanTextForSecrets,
} from "../../../orchestrator/src/safety-verify.js";
import { evaluateCompletedRun } from "../../../orchestrator/src/mission-progress.js";

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed\n${r.stderr}`);
  }
}

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "juno-safety-repo-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "juno@example.test"]);
  git(dir, ["config", "user.name", "Juno Test"]);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "ok.ts"), "export const ok = true;\n", "utf8");
  writeFileSync(path.join(dir, "outside.txt"), "before\n", "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function workbenchFor(repoRoot: string, allowed = "`src/**`"): { workbench: string; missionId: string } {
  const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-safety-wb-"));
  const missionId = "mission-under-test";
  mkdirSync(path.join(workbench, "missions", missionId), { recursive: true });
  writeFileSync(
    path.join(workbench, "missions", missionId, "scope-lock.md"),
    `# Scope\n\n## 允许路径\n- ${allowed}\n- \`${repoRoot}\\src\\**\`\n`,
    "utf8",
  );
  return { workbench, missionId };
}

describe("safety-verify", () => {
  it("passes clean checkpoint", () => {
    const text = "## CHANGES\n- orchestrator/src/safety-verify.ts\n";
    expect(runSafetyVerifyBundle(text).ok).toBe(true);
  });

  it("blocks destructive command in text", () => {
    const text = "- run `rmdir /s /q \"C:\\Juno Oversight\"`";
    const findings = scanTextForDestructiveCommands(text);
    expect(findings.some((f) => f.category === "destructive_cmd")).toBe(true);
    expect(runSafetyVerifyBundle(text).ok).toBe(false);
  });

  it("blocks secret-like patterns", () => {
    const samples = [
      `api_${"key"}: "${"sk-"}${"a".repeat(30)}"`,
      `${"ghp_"}${"b".repeat(30)}`,
      `${"eyJ"}${"a".repeat(8)}.${"b".repeat(8)}.${"c".repeat(8)}`,
      `Authorization: ${"Bearer"} ${"d".repeat(24)}`,
      `${"Cookie"}: session=${"e".repeat(24)}`,
      `${"access_token"}=${"f".repeat(24)}`,
    ];
    for (const text of samples) {
      expect(scanTextForSecrets(text), text).not.toHaveLength(0);
    }
  });

  it("fails closed when verify has no v3 mission baseline", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(report.findings[0].message).toContain("no valid v3 safety baseline");
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("fails closed when a Git observation exits nonzero", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    const oldIndex = process.env.GIT_INDEX_FILE;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      ensureMissionSafetyBaseline(workbench, missionId);
      const invalidIndex = path.join(repoRoot, "invalid-index-directory");
      mkdirSync(invalidIndex);
      process.env.GIT_INDEX_FILE = invalidIndex;

      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(
        report.findings.some((finding) =>
          finding.message.includes("Git observation failed"),
        ),
      ).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
      if (oldIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = oldIndex;
    }
  });

  it("fails closed when a Git diff exceeds the bounded output buffer", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      ensureMissionSafetyBaseline(workbench, missionId);
      writeFileSync(
        path.join(repoRoot, "src", "ok.ts"),
        `export const payload = "${"x".repeat(5 * 1024 * 1024)}";\n`,
        "utf8",
      );

      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(
        report.findings.some((finding) => finding.message.includes("output limit")),
      ).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("rejects hard-linked Git files during baseline capture and verification", () => {
    const baselineRepo = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = baselineRepo;
    try {
      linkSync(
        path.join(baselineRepo, "outside.txt"),
        path.join(baselineRepo, "src", "baseline-hardlink.txt"),
      );
      const baselineWorkbench = workbenchFor(baselineRepo);
      expect(() =>
        ensureMissionSafetyBaseline(
          baselineWorkbench.workbench,
          baselineWorkbench.missionId,
        ),
      ).toThrow(/Hard-linked files are forbidden/);

      const verifyRepo = repo();
      process.env.JUNO_OVERSIGHT_ROOT = verifyRepo;
      const verifyWorkbench = workbenchFor(verifyRepo);
      ensureMissionSafetyBaseline(verifyWorkbench.workbench, verifyWorkbench.missionId);
      linkSync(
        path.join(verifyRepo, "outside.txt"),
        path.join(verifyRepo, "src", "verify-hardlink.txt"),
      );

      const report = runMissionDiffSafetyVerify(
        verifyWorkbench.workbench,
        verifyWorkbench.missionId,
      );
      expect(report.ok).toBe(false);
      expect(
        report.findings.some((finding) => finding.message.includes("Hard-linked files are forbidden")),
      ).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("reports a Workbench hard link even when its control target is excluded", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(
        repoRoot,
        "`missions/mission-under-test/**`",
      );
      ensureMissionSafetyBaseline(workbench, missionId);
      mkdirSync(path.join(workbench, "state"), { recursive: true });
      const controlPath = path.join(workbench, "state", "control.json");
      writeFileSync(controlPath, "{}\n", "utf8");
      linkSync(
        controlPath,
        path.join(workbench, "missions", missionId, "linked-control.json"),
      );

      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(
        report.findings.some((finding) => finding.message.includes("Hard-linked files are forbidden")),
      ).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("does not blame pre-existing dirty files but blocks new out-of-scope changes", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      writeFileSync(path.join(repoRoot, "outside.txt"), "dirty before baseline\n", "utf8");
      const { workbench, missionId } = workbenchFor(repoRoot);
      ensureMissionSafetyBaseline(workbench, missionId);

      expect(runMissionDiffSafetyVerify(workbench, missionId).ok).toBe(true);

      writeFileSync(path.join(repoRoot, "outside.txt"), "dirty after baseline\n", "utf8");
      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(report.findings.some((f) => f.category === "scope_path")).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("detects baseline-dirty files that are reverted or removed", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const tracked = path.join(repoRoot, "outside.txt");
      const untracked = path.join(repoRoot, "outside-untracked.txt");
      writeFileSync(tracked, "dirty before baseline\n", "utf8");
      writeFileSync(untracked, "untracked before baseline\n", "utf8");
      const { workbench, missionId } = workbenchFor(repoRoot);
      ensureMissionSafetyBaseline(workbench, missionId);

      writeFileSync(tracked, "before\n", "utf8");
      unlinkSync(untracked);

      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(report.findings.some((finding) => finding.message.includes("outside.txt"))).toBe(true);
      expect(
        report.findings.some((finding) => finding.message.includes("outside-untracked.txt")),
      ).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("blocks committed secret introduced after baseline", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      ensureMissionSafetyBaseline(workbench, missionId);
      writeFileSync(
        path.join(repoRoot, "src", "secret.ts"),
        `export const api_${"key"} = "${"sk-"}${"a".repeat(30)}";\n`,
        "utf8",
      );
      git(repoRoot, ["add", "."]);
      git(repoRoot, ["commit", "-m", "secret"]);

      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(report.findings.some((f) => f.category === "secret_pattern")).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("blocks a secret and out-of-scope path retained only in post-baseline Git history", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      ensureMissionSafetyBaseline(workbench, missionId);
      const historicalSecret = path.join(repoRoot, "historical-secret.txt");
      writeFileSync(
        historicalSecret,
        `api_${"key"} = "${"sk-"}${"h".repeat(30)}";\n`,
        "utf8",
      );
      git(repoRoot, ["add", "historical-secret.txt"]);
      git(repoRoot, ["commit", "-m", "introduce then remove"]);
      unlinkSync(historicalSecret);
      git(repoRoot, ["add", "historical-secret.txt"]);
      git(repoRoot, ["commit", "-m", "remove from final tree"]);

      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(report.findings.some((finding) => finding.category === "secret_pattern")).toBe(true);
      expect(
        report.findings.some((finding) =>
          finding.message.includes("historical-secret.txt"),
        ),
      ).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("allows nested files covered by a globstar scope", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      ensureMissionSafetyBaseline(workbench, missionId);
      mkdirSync(path.join(repoRoot, "src", "nested", "deep"), { recursive: true });
      writeFileSync(
        path.join(repoRoot, "src", "nested", "deep", "allowed.ts"),
        "export const nested = true;\n",
        "utf8",
      );

      expect(runMissionDiffSafetyVerify(workbench, missionId).ok).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("detects out-of-scope changes inside the non-Git Workbench", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      ensureMissionSafetyBaseline(workbench, missionId);
      writeFileSync(path.join(workbench, "outside-workbench.txt"), "unexpected\n", "utf8");

      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(
        report.findings.some((finding) =>
          finding.message.includes("Changed Workbench path outside mission scope"),
        ),
      ).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("does not apply Juno repository paths to the Workbench namespace", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      writeFileSync(
        path.join(workbench, "missions", missionId, "scope-lock.md"),
        [
          "# Scope",
          "",
          "## 允许修改（Juno 仓库）",
          "- `src/**`",
          "",
          "## 允许修改（Workbench）",
          `- \`missions/${missionId}/**\``,
          "",
        ].join("\n"),
        "utf8",
      );
      ensureMissionSafetyBaseline(workbench, missionId);
      mkdirSync(path.join(workbench, "src"), { recursive: true });
      writeFileSync(path.join(workbench, "src", "namespace-escape.ts"), "escape\n", "utf8");

      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(report.findings.some((finding) => finding.message.includes("namespace-escape.ts"))).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("blocks a staged secret before it is committed", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      ensureMissionSafetyBaseline(workbench, missionId);
      writeFileSync(
        path.join(repoRoot, "src", "staged-secret.ts"),
        `export const api_${"key"} = "${"sk-"}${"a".repeat(30)}";\n`,
        "utf8",
      );
      git(repoRoot, ["add", "src/staged-secret.ts"]);

      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(report.findings.some((finding) => finding.category === "secret_pattern")).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("blocks verify dequeue when mission diff safety fails", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      ensureMissionSafetyBaseline(workbench, missionId);
      writeFileSync(path.join(repoRoot, "outside.txt"), "changed outside\n", "utf8");

      const runId = "verify-run";
      mkdirSync(path.join(workbench, "runs", runId), { recursive: true });
      writeFileSync(
        path.join(workbench, "runs", runId, "manifest.json"),
        `${JSON.stringify({ runKind: "verify" })}\n`,
        "utf8",
      );
      writeFileSync(
        path.join(workbench, "runs", runId, "checkpoint.md"),
        "## VERIFY_REPORT\nPASS\n",
        "utf8",
      );

      expect(evaluateCompletedRun(workbench, runId, missionId).action).toBe("block");
      const safetyPath = path.join(workbench, "runs", runId, "safety-verify.md");
      expect(existsSync(safetyPath)).toBe(true);
      expect(readFileSync(safetyPath, "utf8")).toContain("FAIL");
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("blocks implement dequeue before a later slot can execute unsafe changes", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      ensureMissionSafetyBaseline(workbench, missionId);
      writeFileSync(path.join(repoRoot, "outside.txt"), "changed outside\n", "utf8");

      const runId = "implement-run";
      mkdirSync(path.join(workbench, "runs", runId), { recursive: true });
      writeFileSync(
        path.join(workbench, "runs", runId, "manifest.json"),
        `${JSON.stringify({ runKind: "implement" })}\n`,
        "utf8",
      );
      writeFileSync(
        path.join(workbench, "runs", runId, "checkpoint.md"),
        "STATUS: COMPLETE\n\n## CHANGES\n- intended change\n",
        "utf8",
      );

      expect(evaluateCompletedRun(workbench, runId, missionId).action).toBe("block");
      expect(readFileSync(path.join(workbench, "runs", runId, "safety-verify.md"), "utf8"))
        .toContain("FAIL");
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("blocks Agent changes to mission checkpoint even when the mission directory is allowed", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(
        repoRoot,
        "`missions/mission-under-test/**`",
      );
      ensureMissionSafetyBaseline(workbench, missionId);
      writeFileSync(
        path.join(workbench, "missions", missionId, "checkpoint.md"),
        "STATUS: COMPLETE\n",
        "utf8",
      );

      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(report.findings.some((finding) =>
        finding.message.includes("read-only mission checkpoint"),
      )).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("does not trust a forged baseline inside the writable mission directory", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      ensureMissionSafetyBaseline(workbench, missionId);
      writeFileSync(path.join(repoRoot, "outside.txt"), "out of scope\n", "utf8");
      writeFileSync(
        path.join(workbench, "missions", missionId, "safety-baseline.json"),
        JSON.stringify({ version: 3, roots: [], workbench: { root: workbench, files: {} } }),
        "utf8",
      );

      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(report.findings.some((finding) => finding.message.includes("outside.txt"))).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("freezes scope-lock content and still reports paths hidden by a later widened scope", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      ensureMissionSafetyBaseline(workbench, missionId);
      writeFileSync(
        path.join(workbench, "missions", missionId, "scope-lock.md"),
        "# Scope\n\n## Allowed\n- `**`\n",
        "utf8",
      );
      writeFileSync(path.join(repoRoot, "outside.txt"), "hidden by widened scope\n", "utf8");

      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(report.findings.some((finding) => finding.message.includes("scope-lock changed"))).toBe(true);
      expect(report.findings.some((finding) => finding.message.includes("outside.txt"))).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("ignores only queue/now.yaml runtime churn", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      mkdirSync(path.join(workbench, "queue"), { recursive: true });
      writeFileSync(path.join(workbench, "queue", "now.yaml"), "now: []\n", "utf8");
      ensureMissionSafetyBaseline(workbench, missionId);
      writeFileSync(path.join(workbench, "queue", "now.yaml"), "updated: later\nnow: []\n", "utf8");
      expect(runMissionDiffSafetyVerify(workbench, missionId).ok).toBe(true);

      writeFileSync(path.join(workbench, "queue", "injected.yaml"), "unsafe: true\n", "utf8");
      const report = runMissionDiffSafetyVerify(workbench, missionId);
      expect(report.ok).toBe(false);
      expect(report.findings.some((finding) => finding.message.includes("injected.yaml"))).toBe(true);
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });

  it("refuses to overwrite a malformed canonical baseline", () => {
    const repoRoot = repo();
    const oldEnv = process.env.JUNO_OVERSIGHT_ROOT;
    process.env.JUNO_OVERSIGHT_ROOT = repoRoot;
    try {
      const { workbench, missionId } = workbenchFor(repoRoot);
      const baselinePath = missionSafetyBaselinePath(workbench, missionId);
      mkdirSync(path.dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, "{", "utf8");
      expect(() => ensureMissionSafetyBaseline(workbench, missionId)).toThrow(/will not be replaced/);
      expect(readFileSync(baselinePath, "utf8")).toBe("{");

      const escaped = missionSafetyBaselinePath(workbench, "../../escape");
      expect(path.relative(path.join(workbench, "state", "safety-baselines"), escaped)).not.toMatch(
        /^\.\./,
      );
    } finally {
      process.env.JUNO_OVERSIGHT_ROOT = oldEnv;
    }
  });
});
