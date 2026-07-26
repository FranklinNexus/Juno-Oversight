import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

function invokeEntrypoint(autoQueueBookRevise: boolean) {
  const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-self-optimize-entry-"));
  const entrypointUrl = pathToFileURL(
    path.join(process.cwd(), "scripts", "run-self-optimize.mjs"),
  ).href;
  const program = `
    const { runSelfOptimizeEntrypoint } = await import(${JSON.stringify(entrypointUrl)});
    const successfulChild = () => ({
      status: 0,
      signal: null,
      stdout: "",
      stderr: "",
      error: null,
      timedOut: false,
      terminationConfirmed: true,
    });
    let bootstrapCalls = 0;
    let receivedWorkbench = null;
    const status = await runSelfOptimizeEntrypoint({
      repoRoot: ${JSON.stringify(process.cwd())},
      workbench: ${JSON.stringify(workbench)},
      spawnBuild: async () => successfulChild(),
      spawnBootstrap: async () => {
        bootstrapCalls += 1;
        return successfulChild();
      },
      runSelfOptimize: (value) => {
        receivedWorkbench = value;
        return {
          ranAt: "2026-07-15T00:00:00.000Z",
          autoQueueBookRevise: ${JSON.stringify(autoQueueBookRevise)},
          qualityScan: { failedChapters: ["chapter-01"] },
          rubricPatched: false,
          mcpHintsWritten: false,
          recommendedActions: [],
        };
      },
      log: () => {},
    });
    process.stdout.write(JSON.stringify({ status, bootstrapCalls, receivedWorkbench }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", program],
    { cwd: process.cwd(), encoding: "utf8", shell: false },
  );
  expect(result.status, result.stderr).toBe(0);
  return {
    workbench,
    output: JSON.parse(result.stdout) as {
      status: number;
      bootstrapCalls: number;
      receivedWorkbench: string;
    },
  };
}

describe("self-optimize runtime entrypoint", () => {
  it("never starts the REVISE bootstrap when the run-bound decision is false", () => {
    const result = invokeEntrypoint(false);

    expect(result.output).toEqual({
      status: 0,
      bootstrapCalls: 0,
      receivedWorkbench: result.workbench,
    });
  });

  it("keeps the existing bootstrap behavior when the run-bound decision is true", () => {
    const result = invokeEntrypoint(true);

    expect(result.output).toEqual({
      status: 0,
      bootstrapCalls: 1,
      receivedWorkbench: result.workbench,
    });
  });
});
