import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const AUTONOMY_ENTRYPOINTS = [
  "scripts/run-self-optimize.mjs",
  "scripts/run-evolution-tick.mjs",
  "scripts/queue-hardening.mjs",
  "scripts/show-api-quota.mjs",
];

const PORTABLE_ENTRYPOINTS = [
  "scripts/bootstrap-loop-meta.ps1",
  "scripts/bootstrap-self-iterate.ps1",
  "scripts/bootstrap-smoke-loop.ps1",
  "scripts/bootstrap-juno-hardening.ps1",
  "scripts/lib/agi-advance-core.mjs",
  "scripts/lib/book-advance-core.mjs",
  "scripts/lib/book-decision.mjs",
  "scripts/sync-workbench-hooks.mjs",
];

describe("autonomy runtime entrypoints", () => {
  it.each(AUTONOMY_ENTRYPOINTS)("keeps %s shell-free, abortable, and bounded", (file) => {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");

    expect(source).not.toMatch(/\bspawnSync\b|shell:\s*true/);
    expect(source).toContain("spawnPnpmWithTimeout");
    expect(source).toContain("BUILD_TIMEOUT_MS");
    expect(source).toContain("signal: shutdownController.signal");
  });

  it.each(PORTABLE_ENTRYPOINTS)("derives the repository root for %s", (file) => {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");

    expect(source).not.toMatch(/[A-Za-z]:\\Users\\/i);
    expect(source).toMatch(file.endsWith(".ps1") ? /\$PSScriptRoot/ : /import\.meta\.url/);
  });

  it("keeps Windows process-tree termination independent of taskkill and WBEM", () => {
    const sources = [
      "scripts/lib/specialized-loop-guard.mjs",
      "scripts/free-port.mjs",
      "orchestrator/src/verify-runner.ts",
    ];
    for (const file of sources) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source, file).not.toContain("taskkill.exe");
    }
    const nativeHelper = readFileSync(
      path.join(process.cwd(), "scripts", "terminate-process-tree.ps1"),
      "utf8",
    );
    expect(nativeHelper).toContain("CreateToolhelp32Snapshot");
    expect(nativeHelper).toContain("TerminateProcess");
    expect(nativeHelper).not.toMatch(/Get-(?:Cim|Wmi)Instance/);
  });
});
