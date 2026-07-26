import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseLoginStartupArgs,
  resolveLoginWorkbenchRoot,
  supportsJunoNode,
} from "../../../scripts/start-juno-login.mjs";

describe("low-memory Windows login startup", () => {
  it("enforces the desktop Node floor and a closed argument contract", () => {
    expect(supportsJunoNode("v22.13.0")).toBe(true);
    expect(supportsJunoNode("22.99.1")).toBe(true);
    expect(supportsJunoNode("v23.0.0")).toBe(true);
    expect(supportsJunoNode("v22.12.9")).toBe(false);
    expect(supportsJunoNode("invalid")).toBe(false);

    expect(parseLoginStartupArgs(["--config-root=C:\\Juno", "--validate-only"]))
      .toMatchObject({ validateOnly: true });
    expect(() => parseLoginStartupArgs(["--unknown"])).toThrow(/unknown/);
    expect(() => parseLoginStartupArgs(["--validate-only", "--validate-only"]))
      .toThrow(/only be provided once/);
  });

  it("resolves Workbench config with environment and dotenv precedence", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "juno-login-config-"));
    try {
      writeFileSync(path.join(root, ".env"), "AGENT_WORKBENCH_ROOT=C:\\base\n", "utf8");
      writeFileSync(
        path.join(root, ".env.local"),
        "AGENT_WORKBENCH_ROOT=C:\\local\n",
        "utf8",
      );
      expect(resolveLoginWorkbenchRoot(root, {})).toBe("C:\\local");
      expect(resolveLoginWorkbenchRoot(root, { AGENT_WORKBENCH_ROOT: "C:\\explicit" }))
        .toBe("C:\\explicit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers direct Node execution without starting a WebView or auto-restarting blocks", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      path.join(process.cwd(), "scripts", "install-juno-login-task.ps1"),
      "utf8",
    );
    expect(source).toContain("$Task.Triggers.Create(9)");
    expect(source).toContain("$Task.Actions.Create(0)");
    expect(source).toContain("$Action.Path = $NodePath");
    expect(source).toContain("$Task.Settings.MultipleInstances = 2");
    expect(source).toContain("--validate-only");
    expect(source).toContain("[switch]$StartNow");
    expect(source).toContain("$Task.Settings.RestartCount = 0");
    expect(source).not.toContain("New-ScheduledTask");
    expect(source).not.toMatch(/\$Action\.Path\s*=\s*[^\r\n]*(?:tauri|webview)/i);
  });
});
