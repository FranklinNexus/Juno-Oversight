import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backupExistingQueue } from "../../../scripts/lib/pre-loop-queue.mjs";

describe("minimal loop bootstrap", () => {
  it("starts without an existing queue and backs up one when present", () => {
    const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-loop-bootstrap-"));
    try {
      expect(backupExistingQueue(workbench, 100)).toBeNull();

      const queueDir = path.join(workbench, "queue");
      const queuePath = path.join(queueDir, "now.yaml");
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(queuePath, "now: []\n", "utf8");

      const backupPath = backupExistingQueue(workbench, 101);
      expect(backupPath).toBe(path.join(queueDir, "now.yaml.bak-pre-loop-101"));
      expect(readFileSync(backupPath!, "utf8")).toBe("now: []\n");
    } finally {
      rmSync(workbench, { recursive: true, force: true });
    }
  });

  it("provisions every prompt template referenced by the smoke queue", () => {
    const source = readFileSync(
      path.join(process.cwd(), "scripts", "bootstrap-smoke-loop.ps1"),
      "utf8",
    );
    const promptWrite = source.indexOf("[System.IO.File]::WriteAllText($promptPath");
    const queueSubmission = source.indexOf("Submit-JunoQueueCandidate");

    expect(source).toContain('Join-Path $Workbench "prompts"');
    for (const template of [
      "executor_implement",
      "executor_review",
      "executor_verify",
    ]) {
      expect(source).toContain(`${template} = @\"`);
    }
    expect(promptWrite).toBeGreaterThan(-1);
    expect(promptWrite).toBeLessThan(queueSubmission);
  });

  it("delegates UI verification to the isolated dev smoke runner", () => {
    const source = readFileSync(
      path.join(process.cwd(), "scripts", "run-minimal-loop.mjs"),
      "utf8",
    );

    expect(source).toContain('return runCmd("dev smoke", "pnpm", ["dev:smoke"]);');
    expect(source).not.toContain('spawn("pnpm", ["dev", "--port", "3000"]');
    expect(source).not.toContain('dev.kill("SIGTERM")');
  });
});
