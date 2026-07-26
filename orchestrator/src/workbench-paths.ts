import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

const SAFE_WORKBENCH_ID = /^[\p{L}\p{N}](?:[\p{L}\p{N}._-]{0,126}[\p{L}\p{N}])?$/u;
const WINDOWS_RESERVED_ID = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

export type WorkbenchRootName = "missions" | "queue" | "runs" | "state";

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function canonicalWorkbench(workbench: string): string {
  return realpathSync.native(path.resolve(workbench));
}

/** Validate that a control root is the real direct child of the canonical Workbench. */
export function validateWorkbenchRootDirectory(
  workbench: string,
  rootName: WorkbenchRootName,
): string {
  const canonicalRoot = canonicalWorkbench(workbench);
  const lexicalRoot = path.join(path.resolve(workbench), rootName);
  const stat = lstatSync(lexicalRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Workbench ${rootName} root must be a non-link directory: ${lexicalRoot}`);
  }
  const actualRoot = realpathSync.native(lexicalRoot);
  const expectedRoot = path.join(canonicalRoot, rootName);
  if (!samePath(actualRoot, expectedRoot)) {
    throw new Error(`Workbench ${rootName} root escapes canonical containment: ${lexicalRoot}`);
  }
  return actualRoot;
}

/** Create a missing direct control root without following a substituted child path. */
export function ensureWorkbenchRootDirectory(
  workbench: string,
  rootName: WorkbenchRootName,
): string {
  const canonicalRoot = canonicalWorkbench(workbench);
  const target = path.join(canonicalRoot, rootName);
  if (!existsSync(target)) mkdirSync(target);
  return validateWorkbenchRootDirectory(canonicalRoot, rootName);
}

function validateWorkbenchChildDirectory(
  workbench: string,
  rootName: "missions" | "runs",
  childId: string,
): string {
  const root = validateWorkbenchRootDirectory(workbench, rootName);
  const child = path.join(root, childId);
  const stat = lstatSync(child);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Workbench ${rootName} child must be a non-link directory: ${child}`);
  }
  const actual = realpathSync.native(child);
  const expected = path.join(root, childId);
  if (!samePath(actual, expected)) {
    throw new Error(`Workbench ${rootName} child escapes canonical containment: ${child}`);
  }
  return actual;
}

function assertSafeWorkbenchId(kind: "mission" | "run", value: string): void {
  if (!SAFE_WORKBENCH_ID.test(value) || WINDOWS_RESERVED_ID.test(value)) {
    throw new Error(`Invalid ${kind} id: ${value}`);
  }
}

export function resolveMissionDirectory(workbench: string, missionId: string): string {
  assertSafeWorkbenchId("mission", missionId);
  return path.join(workbench, "missions", missionId);
}

export function resolveRunDirectory(workbench: string, runId: string): string {
  assertSafeWorkbenchId("run", runId);
  return path.join(workbench, "runs", runId);
}

export function validateMissionDirectory(workbench: string, missionId: string): string {
  assertSafeWorkbenchId("mission", missionId);
  return validateWorkbenchChildDirectory(workbench, "missions", missionId);
}

export function validateRunDirectory(workbench: string, runId: string): string {
  assertSafeWorkbenchId("run", runId);
  return validateWorkbenchChildDirectory(workbench, "runs", runId);
}

export interface ValidatedRunManifestPath {
  manifestPath: string;
  runDir: string;
  runId: string;
}

export function assertRunManifestId(
  location: ValidatedRunManifestPath,
  manifestRunId: unknown,
): asserts manifestRunId is string {
  if (typeof manifestRunId !== "string" || manifestRunId !== location.runId) {
    throw new Error(
      `Run manifest id does not match its directory: ${String(manifestRunId)} != ${location.runId}`,
    );
  }
}

export function validateRunManifestPath(
  workbench: string,
  suppliedManifestPath: string,
): ValidatedRunManifestPath {
  const canonicalWorkbench = realpathSync.native(path.resolve(workbench));
  const lexicalRuns = path.join(canonicalWorkbench, "runs");
  if (!existsSync(lexicalRuns)) throw new Error(`Workbench runs directory is missing: ${lexicalRuns}`);
  const canonicalRuns = realpathSync.native(lexicalRuns);
  if (!samePath(canonicalRuns, lexicalRuns)) {
    throw new Error(`Workbench runs directory must not be a link: ${lexicalRuns}`);
  }

  const supplied = path.resolve(suppliedManifestPath);
  if (!samePath(path.basename(supplied), "manifest.json")) {
    throw new Error(`Run manifest must be named manifest.json: ${suppliedManifestPath}`);
  }
  if (!existsSync(supplied)) throw new Error(`Run manifest does not exist: ${supplied}`);

  const lexicalRunDir = path.dirname(supplied);
  const runId = path.basename(lexicalRunDir);
  assertSafeWorkbenchId("run", runId);
  const expectedLexical = path.join(lexicalRuns, runId, "manifest.json");
  if (!samePath(supplied, expectedLexical)) {
    throw new Error(`Run manifest is outside Workbench runs: ${supplied}`);
  }

  const canonicalRunDir = realpathSync.native(lexicalRunDir);
  const canonicalRunId = path.basename(canonicalRunDir);
  assertSafeWorkbenchId("run", canonicalRunId);
  if (
    !samePath(path.dirname(canonicalRunDir), canonicalRuns) ||
    !samePath(canonicalRunId, runId)
  ) {
    throw new Error(`Run directory escapes Workbench runs through a link: ${lexicalRunDir}`);
  }
  const canonicalManifest = realpathSync.native(supplied);
  const expectedCanonical = path.join(canonicalRunDir, "manifest.json");
  if (!samePath(canonicalManifest, expectedCanonical)) {
    throw new Error(`Run manifest must not be a link: ${supplied}`);
  }
  return { manifestPath: canonicalManifest, runDir: canonicalRunDir, runId: canonicalRunId };
}
