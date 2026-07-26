import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRuntimeSize,
  REQUIRED_RUNTIME_ASSETS,
  RUNTIME_SCRIPT_FILES,
  RUNTIME_TEMPLATE_FILES,
  RUNTIME_WIKI_FILES,
  stageDesktopRuntime,
  validateStagedRuntime,
} from "../../../scripts/prepare-desktop-runtime.mjs";
import { PACKAGED_RUNTIME_REQUIRED_ASSETS } from "../../../scripts/lib/pnpm-runner.mjs";

function write(root: string, relative: string, content = "fixture\n") {
  const target = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "juno-desktop-runtime-"));
  write(
    root,
    "package.json",
    `${JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      engines: { node: ">=22.13.0" },
      packageManager: "pnpm@10.13.1",
    })}\n`,
  );
  write(
    root,
    "orchestrator/package.json",
    `${JSON.stringify({
      name: "juno-orchestrator",
      version: "1.0.0",
      type: "module",
      engines: { node: ">=22.13.0" },
      dependencies: { "@openai/codex-sdk": "test", yaml: "test" },
    })}\n`,
  );
  for (const asset of REQUIRED_RUNTIME_ASSETS) {
    if (!asset.startsWith("orchestrator/dist/")) continue;
    write(root, asset, "export {};\n");
  }
  write(root, "orchestrator/workflows/default.json", "{}\n");
  for (const file of RUNTIME_SCRIPT_FILES) write(root, `scripts/${file}`, "export {};\n");
  for (const file of RUNTIME_WIKI_FILES) write(root, `wiki/${file}`);
  for (const file of RUNTIME_TEMPLATE_FILES) write(root, `missions-templates/${file}`);
  write(root, "config/README.md");
  write(root, "config/runtime.example.json", "{}\n");
  write(root, "config/local-production.json", '{"mustNotShip":true}\n');
  write(
    root,
    "orchestrator/node_modules/@openai/codex-sdk/package.json",
    '{"name":"@openai/codex-sdk","type":"module","exports":"./dist/index.js"}\n',
  );
  write(
    root,
    "orchestrator/node_modules/@openai/codex-sdk/dist/index.js",
    "export class Codex {}\n",
  );
  write(
    root,
    "orchestrator/node_modules/yaml/package.json",
    '{"name":"yaml","main":"./dist/index.js"}\n',
  );
  write(root, "orchestrator/node_modules/yaml/dist/index.js", "module.exports = {};\n");
  write(
    root,
    "orchestrator/node_modules/@openai/codex-win32-x64/vendor/codex.exe",
    "must not ship\n",
  );
  return {
    root,
    output: path.join(root, "src-tauri", "resources", "juno-runtime"),
  };
}

describe("desktop runtime packaging", () => {
  it("keeps the staging, Node, and Rust required-asset guards synchronized", () => {
    expect([...PACKAGED_RUNTIME_REQUIRED_ASSETS]).toEqual(REQUIRED_RUNTIME_ASSETS);
    const rustLoader = readFileSync(
      path.join(process.cwd(), "src-tauri", "src", "orchestrator.rs"),
      "utf8",
    );
    for (const asset of REQUIRED_RUNTIME_ASSETS) {
      expect(rustLoader).toContain(`"${asset}"`);
    }
  });

  it("stages only the bounded runtime closure and rejects integrity or secret drift", () => {
    const fixture = createFixture();
    try {
      const manifest = stageDesktopRuntime({
        repoRoot: fixture.root,
        outputRoot: fixture.output,
      });
      expect(manifest.totalBytes).toBeGreaterThan(0);
      expect(manifest.totalBytes).toBeLessThan(20 * 1024 * 1024);
      expect(manifest.assets.some((asset: { path: string }) =>
        /codex-(?:win32|linux|darwin)-/i.test(asset.path)
      )).toBe(false);
      expect(existsSync(path.join(fixture.output, "config", "runtime.example.json"))).toBe(true);
      expect(existsSync(path.join(fixture.output, "config", "local-production.json"))).toBe(false);
      expect(existsSync(path.join(fixture.output, "scripts", "run-workflow-experiment.mjs"))).toBe(true);
      expect(existsSync(path.join(fixture.output, "scripts", "migrate-workflow-selection.mjs"))).toBe(true);
      const runtimePackage = JSON.parse(readFileSync(path.join(fixture.output, "package.json"), "utf8"));
      expect(runtimePackage.scripts["evolution:canary"]).toContain("--skip-build");
      expect(runtimePackage.scripts["workflow:selection:migrate"]).toContain("--skip-build");
      for (const command of Object.values(runtimePackage.scripts) as string[]) {
        const script = command.match(/^node (scripts\/[^ ]+)/)?.[1];
        expect(script, command).toBeDefined();
        expect(existsSync(path.join(fixture.output, ...script!.split("/"))), command).toBe(true);
      }

      rmSync(
        path.join(fixture.root, "orchestrator", "dist", "execution-artifact.js"),
      );
      expect(() =>
        stageDesktopRuntime({ repoRoot: fixture.root, outputRoot: fixture.output })
      ).toThrow(/missing required asset: orchestrator\/dist\/execution-artifact\.js/);
      write(
        fixture.root,
        "orchestrator/dist/execution-artifact.js",
        "export {};\n",
      );

      writeFileSync(
        path.join(fixture.output, "orchestrator", "dist", "spawn-run.js"),
        "tampered\n",
        "utf8",
      );
      expect(() => validateStagedRuntime(fixture.output)).toThrow(/integrity verification/);

      stageDesktopRuntime({ repoRoot: fixture.root, outputRoot: fixture.output });
      const manifestPath = path.join(fixture.output, "runtime-manifest.json");
      const escaped = JSON.parse(readFileSync(manifestPath, "utf8"));
      escaped.assets[0].path = "../outside.js";
      writeFileSync(manifestPath, `${JSON.stringify(escaped, null, 2)}\n`, "utf8");
      expect(() => validateStagedRuntime(fixture.output)).toThrow(/escapes its root/);

      write(
        fixture.root,
        "scripts/run-juno-daemon.mjs",
        `export const leaked = "${["sk", "1234567890abcdefghi"].join("-")}";\n`,
      );
      expect(() =>
        stageDesktopRuntime({ repoRoot: fixture.root, outputRoot: fixture.output })
      ).toThrow(/secret-like content/);

      expect(() => assertRuntimeSize(20 * 1024 * 1024 + 1)).toThrow(/exceeds/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
