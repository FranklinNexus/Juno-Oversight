import { describe, expect, it } from "vitest";
import { resolvePnpmInvocation, spawnPnpmSync } from "../../../scripts/lib/pnpm-runner.mjs";

describe("pnpm-runner", () => {
  it("uses a shell-free JavaScript entrypoint", () => {
    const invocation = resolvePnpmInvocation(["--version"]);
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args[0]).toMatch(/pnpm\.(?:c?js)$/i);

    const result = spawnPnpmSync(["--version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(String(result.stdout).trim()).toBe("10.13.1");
  });
});
