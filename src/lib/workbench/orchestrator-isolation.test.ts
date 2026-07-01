import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("orchestrator package isolation", () => {
  it("must not file:.. link to parent (breaks Next/Turbopack)", () => {
    const pkgPath = path.join(process.cwd(), "orchestrator", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
      expect(spec, `${name} must not symlink parent`).not.toMatch(/^file:\.\./);
    }
  });
});
