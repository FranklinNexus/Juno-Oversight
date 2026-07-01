import { describe, expect, it } from "vitest";
import { classifyShellCommand } from "../../../orchestrator/src/safety-doctrine.js";

describe("classifyShellCommand", () => {
  it("allows benign commands", () => {
    expect(classifyShellCommand("pnpm test").blocked).toBe(false);
    expect(classifyShellCommand('Remove-Item ".next" -Recurse -Force').blocked).toBe(false);
  });

  it("blocks rmdir on Juno Oversight paths", () => {
    const verdict = classifyShellCommand(
      'rmdir /s /q "D:\\DesktopData\\Entrepreneurship\\Juno Oversight"',
    );
    expect(verdict.blocked).toBe(true);
    expect(verdict.category).toBe("protected_root");
  });

  it("blocks git reset --hard", () => {
    expect(classifyShellCommand("git reset --hard").blocked).toBe(true);
  });

  it("blocks rm -rf on broad targets", () => {
    expect(classifyShellCommand("rm -rf .").blocked).toBe(true);
  });

  it("blocks Remove-Item on Entrepreneurship parent", () => {
    const verdict = classifyShellCommand(
      'Remove-Item -Recurse -Force "C:\\Users\\kfr34\\Desktop\\Entrepreneurship"',
    );
    expect(verdict.blocked).toBe(true);
  });
});
