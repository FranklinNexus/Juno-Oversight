import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createManifestControlGuard,
  MAX_RUN_MANIFEST_BYTES,
  readTrustedRunManifest,
} from "../../../orchestrator/src/spawn-run.js";
import type { RunManifest } from "../../../orchestrator/src/types.js";

function fixture(runId: string): {
  workbench: string;
  runDir: string;
  manifestPath: string;
  manifest: RunManifest;
} {
  const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-spawn-manifest-"));
  const runDir = path.join(workbench, "runs", runId);
  const manifestPath = path.join(runDir, "manifest.json");
  mkdirSync(path.join(workbench, "prompts"), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(workbench, "prompts", "executor_review.md"), "# Review\n", "utf8");
  const manifest: RunManifest = {
    runId,
    horizon: "mission",
    runKind: "review",
    repoRoot: "juno-overseer",
    provider: "openai_codex",
    promptTemplate: "executor_review",
    cwd: ".",
    maxMinutes: 1,
    maxRetries: 3,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  return { workbench, runDir, manifestPath, manifest };
}

describe("spawn-run manifest trust boundary", () => {
  it("reads and canonicalizes a valid manifest through the trusted reader", () => {
    const { workbench, manifestPath, manifest } = fixture("trusted-manifest");
    const trusted = readTrustedRunManifest(workbench, manifestPath);

    expect(trusted.location.manifestPath).toBe(manifestPath);
    expect(trusted.manifest).toMatchObject(manifest);
  });

  it("rejects a hard-linked manifest", () => {
    const { workbench, runDir, manifestPath } = fixture("hardlink-manifest");
    const source = path.join(runDir, "manifest-source.json");
    writeFileSync(source, readFileSync(manifestPath));
    unlinkSync(manifestPath);
    linkSync(source, manifestPath);

    expect(() => readTrustedRunManifest(workbench, manifestPath)).toThrow(
      /exclusive regular file/i,
    );
  });

  it("rejects a manifest above the descriptor read limit", () => {
    const { workbench, manifestPath } = fixture("oversize-manifest");
    writeFileSync(manifestPath, Buffer.alloc(MAX_RUN_MANIFEST_BYTES + 1, 0x20));

    expect(() => readTrustedRunManifest(workbench, manifestPath)).toThrow(/byte limit/i);
  });

  it("rejects invalid UTF-8 before JSON parsing", () => {
    const { workbench, manifestPath } = fixture("invalid-utf8-manifest");
    writeFileSync(manifestPath, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]));

    expect(() => readTrustedRunManifest(workbench, manifestPath)).toThrow(/valid UTF-8/i);
  });

  it("rejects same-file mutation during the descriptor read", () => {
    const { workbench, manifestPath, manifest } = fixture("drifting-manifest");

    expect(() =>
      readTrustedRunManifest(workbench, manifestPath, {
        afterRead: () => {
          writeFileSync(
            manifestPath,
            `${JSON.stringify({ ...manifest, maxMinutes: 2 })}\n`,
            "utf8",
          );
        },
      }),
    ).toThrow(/changed while reading|size changed while reading/i);
  });

  it("rejects pathname replacement during the descriptor read", () => {
    const { workbench, runDir, manifestPath, manifest } = fixture("replaced-manifest");
    const displaced = path.join(runDir, "manifest.displaced.json");
    const replacement = path.join(runDir, "manifest.replacement.json");
    writeFileSync(replacement, `${JSON.stringify({ ...manifest, maxMinutes: 2 })}\n`, "utf8");

    expect(() =>
      readTrustedRunManifest(workbench, manifestPath, {
        afterRead: () => {
          renameSync(manifestPath, displaced);
          renameSync(replacement, manifestPath);
        },
      }),
    ).toThrow(/changed while reading/i);
  });

  it("restores an oversized control file without reading it unbounded", () => {
    const { manifestPath, manifest } = fixture("guard-oversize");
    const guard = createManifestControlGuard(manifestPath, manifest);
    writeFileSync(manifestPath, Buffer.alloc(MAX_RUN_MANIFEST_BYTES + 1, 0x20));

    expect(() => guard.assertUnchangedAndRestore()).toThrow(/drift detected and restored/i);
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual(manifest);
  });
});
