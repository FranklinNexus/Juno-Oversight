import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readJson(relativePath: string): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")) as {
    scripts?: Record<string, string>;
  };
}

describe("package workspace contract", () => {
  it("installs the orchestrator from the canonical pnpm workspace lock", () => {
    const workspace = readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    const lock = readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");

    expect(workspace).toMatch(/^packages:\s*\r?\n(?:\s{2}-[^\r\n]+\r?\n)*\s{2}-\s*['\"]?orchestrator['\"]?\s*$/m);
    expect(lock).toMatch(/^  orchestrator:\s*$/m);
    expect(existsSync(path.join(repoRoot, "orchestrator", "package-lock.json"))).toBe(false);
  });

  it("keeps orchestrator build free of dependency installation side effects", () => {
    const scripts = readJson("package.json").scripts ?? {};
    const orchestratorScripts = readJson("orchestrator/package.json").scripts ?? {};
    const build = scripts["orchestrator:build"] ?? "";

    expect(build).toContain("check-orchestrator-deps.mjs");
    expect(build).toContain("--filter juno-orchestrator build");
    expect(build).not.toMatch(/install-orchestrator|\b(?:npm|pnpm)\s+install\b/);
    expect(scripts["orchestrator:test:dry"]).toContain("orchestrator:build");
    expect(orchestratorScripts.preinstall).toContain("check-package-manager.mjs");
    expect(orchestratorScripts.preinstall).toContain("check-orchestrator-deps.mjs");
    expect(existsSync(path.join(repoRoot, "scripts", "install-orchestrator.mjs"))).toBe(false);
  });

  it("builds the orchestrator before tests in the desktop verification gate", () => {
    const verify = readFileSync(path.join(repoRoot, "scripts", "verify-desktop.mjs"), "utf8");
    const contractIndex = verify.indexOf('run("workspace dependency contract"');
    const buildIndex = verify.indexOf('run("orchestrator:build"');
    const testIndex = verify.indexOf('run("pnpm test"');

    expect(contractIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(contractIndex);
    expect(testIndex).toBeGreaterThan(buildIndex);
  });

  it("keeps the long workflow policy suite below the Vitest worker RPC timeout", () => {
    const runner = readFileSync(path.join(repoRoot, "scripts", "run-tests.mjs"), "utf8");

    expect(runner).not.toContain(
      'testNamePattern: "^workflow experiment isolation and policy",',
    );
    expect(runner).toContain(
      '"^workflow experiment isolation and policy (?!rejects )"',
    );
    expect(runner).toContain(
      '"^workflow experiment isolation and policy rejects (?=[a-mA-M])"',
    );
    expect(runner).toContain(
      '"^workflow experiment isolation and policy rejects (?![a-mA-M])"',
    );
    expect(runner).not.toContain(
      '"^workflow experiment receipts and activation (?=[r-zR-Z])"',
    );
    for (const pattern of [
      "^workflow experiment receipts and activation (?=re(?:stores|quires|covers))",
      "^workflow experiment receipts and activation (?=r(?:efuses|olls))",
      "^workflow experiment receipts and activation (?=[a-mA-M])",
      "^workflow experiment receipts and activation (?![a-mA-Mr-zR-Z])",
    ]) {
      expect(runner).toContain(JSON.stringify(pattern));
    }
  });

  it("uses an isolated localhost smoke and includes Rust tests in the desktop gate", () => {
    const smoke = readFileSync(path.join(repoRoot, "scripts", "dev-smoke.mjs"), "utf8");
    const verify = readFileSync(path.join(repoRoot, "scripts", "verify-desktop.mjs"), "utf8");
    const gitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
    const smokeIndex = verify.indexOf('run("dev smoke (Turbopack)"');
    const cargoCheckIndex = verify.indexOf('run("cargo check"');
    const cargoTestIndex = verify.indexOf('run("cargo test"');

    expect(smoke).toContain('const HOST = "localhost"');
    expect(smoke).not.toContain("127.0.0.1");
    expect(smoke).not.toContain("3099");
    expect(smoke).toContain("mkdtempSync");
    expect(smoke).toContain('path.join(root, ".juno-dev-smoke")');
    expect(smoke).toContain("spawnWithTimeout");
    expect(smoke).toContain('"--hostname", HOST');
    expect(smoke).toContain("waitForPortRelease");
    expect(smoke).toContain("removeIsolatedFixture");
    expect(gitignore).toMatch(/^\/\.juno-dev-smoke\/$/m);
    expect(gitignore).toMatch(/^\/\.pnpm-store\/?$/m);
    expect(cargoCheckIndex).toBeGreaterThan(smokeIndex);
    expect(cargoTestIndex).toBeGreaterThan(cargoCheckIndex);
  });
});
