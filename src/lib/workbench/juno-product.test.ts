import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectDoctorReport } from "../../../scripts/lib/juno-doctor-core.mjs";
import { initializeJuno } from "../../../scripts/lib/juno-setup-core.mjs";
import {
  loadProjectEnv,
  parseEnvText,
} from "../../../scripts/lib/project-env.mjs";

describe("Juno product setup", () => {
  it("parses quoted dotenv values", () => {
    expect(parseEnvText('A="path with spaces"\nB=value\n# C=ignored\n')).toEqual({
      A: "path with spaces",
      B: "value",
    });
  });

  it("loads project-local environment without replacing explicit process values", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "juno-env-"));
    const priorA = process.env.JUNO_TEST_A;
    const priorB = process.env.JUNO_TEST_B;
    try {
      writeFileSync(path.join(repo, ".env.local"), "JUNO_TEST_A=local\nJUNO_TEST_B=local\n");
      process.env.JUNO_TEST_A = "explicit";
      delete process.env.JUNO_TEST_B;
      loadProjectEnv(repo);
      expect(process.env.JUNO_TEST_A).toBe("explicit");
      expect(process.env.JUNO_TEST_B).toBe("local");
    } finally {
      if (priorA == null) delete process.env.JUNO_TEST_A;
      else process.env.JUNO_TEST_A = priorA;
      if (priorB == null) delete process.env.JUNO_TEST_B;
      else process.env.JUNO_TEST_B = priorB;
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("creates an empty, idempotent, diagnosable workbench", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "juno-product-"));
    const repo = path.join(root, "repo");
    const workbench = path.join(root, "workbench");
    const envFile = path.join(root, ".env.local");
    try {
      for (const directory of [
        path.join(repo, ".cursor"),
        path.join(repo, "config"),
        path.join(repo, "node_modules", "next"),
        path.join(repo, "orchestrator", "node_modules", "@cursor", "sdk"),
      ]) {
        mkdirSync(directory, { recursive: true });
      }
      writeFileSync(path.join(repo, "package.json"), "{}\n");
      writeFileSync(path.join(repo, ".cursor", "hooks.json"), "{}\n");
      writeFileSync(path.join(repo, "config", "api-limits.example.json"), "{}\n");
      writeFileSync(path.join(repo, "node_modules", "next", "package.json"), "{}\n");

      const first = initializeJuno({ repoRoot: repo, workbench, envFile });
      expect(first.ok).toBe(true);
      expect(readFileSync(path.join(workbench, "queue", "now.yaml"), "utf8")).toContain(
        "now:\n  []",
      );
      expect(existsSync(path.join(workbench, ".cursor", "hooks.json"))).toBe(true);
      expect(existsSync(path.join(workbench, "config", "api-limits.json"))).toBe(true);
      expect(parseEnvText(readFileSync(envFile, "utf8"))).toMatchObject({
        AGENT_WORKBENCH_ROOT: path.resolve(workbench),
        JUNO_OVERSIGHT_ROOT: path.resolve(repo),
      });

      writeFileSync(
        path.join(workbench, "queue", "now.yaml"),
        "now:\n  - id: keep-me\nbacklog:\n  []\n",
      );
      const second = initializeJuno({ repoRoot: repo, workbench, envFile });
      expect(second.changes.preserved).toContain(path.join(workbench, "queue", "now.yaml"));
      expect(readFileSync(path.join(workbench, "queue", "now.yaml"), "utf8")).toContain(
        "keep-me",
      );

      mkdirSync(path.join(workbench, "state"), { recursive: true });
      const priorKey = process.env.CURSOR_API_KEY;
      delete process.env.CURSOR_API_KEY;
      const report = collectDoctorReport({
        repoRoot: repo,
        workbench,
        pidChecker: () => false,
      });
      if (priorKey == null) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = priorKey;
      expect(report.ok).toBe(true);
      expect(report.readyForSmoke).toBe(true);
      expect(report.readyForLive).toBe(false);
      expect(report.checks).toContainEqual(
        expect.objectContaining({ id: "safety_hooks", status: "pass" }),
      );
      expect(report.checks).toContainEqual(
        expect.objectContaining({ id: "scheduler_enabled", status: "pass" }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
