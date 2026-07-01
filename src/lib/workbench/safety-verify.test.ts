import { describe, expect, it } from "vitest";
import {
  runSafetyVerifyBundle,
  scanTextForDestructiveCommands,
  scanTextForSecrets,
} from "../../../orchestrator/src/safety-verify.js";

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
    const text = 'api_key: "sk-abcdefghijklmnopqrstuvwxyz123456"';
    expect(scanTextForSecrets(text).length).toBeGreaterThan(0);
  });
});
