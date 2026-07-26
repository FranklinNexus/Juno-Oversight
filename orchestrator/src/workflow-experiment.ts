import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  buildReviseImplementItem,
  parseReviewVerdict,
  type WorkflowExperimentRevisionPromptBinding,
} from "./mission-progress.js";
import {
  EXECUTION_ARTIFACT_VERSION,
  executionAttemptBinding,
  verifyStepId,
  type ExecutionAttemptBinding,
} from "./execution-artifact.js";
import { normalizeEvalProfile, verifyStepsForProfile, type VerifyStep } from "./eval-profile.js";
import { buildManifestFromQueue } from "./manifest.js";
import { readPromptTemplateSnapshot } from "./prompt-template.js";
import { observeRunOutcome } from "./run-outcome.js";
import {
  queueItemFingerprint,
  readNowQueueSnapshot,
  replaceQueueSnapshotConditional,
} from "./queue-io.js";
import { revisionFixRunId } from "./revision-lineage.js";
import type { QueueItem, RunKind, RunState, WorkflowExperimentArm } from "./types.js";
import { verifyStepInvocationEvidence } from "./verify-runner.js";
import {
  compileWorkflowSlots,
  loadWorkflow,
  workflowDefinitionSha256,
} from "./workflow.js";
import {
  ensureWorkbenchRootDirectory,
  resolveMissionDirectory,
  resolveRunDirectory,
  validateMissionDirectory,
  validateRunManifestPath,
  validateWorkbenchRootDirectory,
} from "./workbench-paths.js";
import { readExclusiveControlText } from "./control-file.js";

export const WORKFLOW_EXPERIMENT_VERSION = 1 as const;
export const WORKFLOW_EXPERIMENT_RECEIPT_VERSION = 1 as const;
export const WORKFLOW_SELECTION_MIGRATION_RECEIPT_VERSION = 1 as const;
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MIN_EPISODES = 2;
const MAX_EPISODES = 10;
const MAX_CONTROL_RECORD_BYTES = 256 * 1024;
const MAX_SELECTION_BYTES = 64 * 1024;
const MAX_SELECTION_LOCK_BYTES = 16 * 1024;
const MAX_RUN_EVIDENCE_BYTES = 4 * 1024 * 1024;
const SELECTION_LOCK_STALE_MS = 30_000;
const SELECTION_LOCK_MAX_OWNER_AGE_MS = 5 * 60_000;
const FIXTURE_MISSION_TOKEN = "__JUNO_WORKFLOW_EXPERIMENT_MISSION__";
const AXIOM_BOOK_MISSION_ID = "juno-axiom-book-2026";
const LITERATURE_CANARY_PROMPTS = {
  implement: "workflow_canary_literature_v1",
  review: "workflow_canary_literature_v1",
  verify: "workflow_canary_literature_v1",
} as const;
const LITERATURE_CANARY_PROMPT_TEXT = {
  [LITERATURE_CANARY_PROMPTS.implement]: [
    "# Workflow canary literature task",
    "",
    "Work only in the current isolated mission directory.",
    "Follow the runKind shown in the parent prompt:",
    "- implement: read brief.md, rubric.md, and essay.md; improve only essay.md; cite [S1], [S2], and [S3]; write STATUS: COMPLETE, ## CHANGES, and ## METACOGNITION;",
    "- review, debate, or vote: do not modify mission artifacts; write a complete REVIEW_VERDICT; use PASS only when every rubric item is met; debate also includes ## DEBATE;",
    "- verify: do not modify mission artifacts; record a ## VERIFY_REPORT; the deterministic parent verifier is authoritative.",
    "Never edit brief.md, rubric.md, north-star.md, scope-lock.md, or progress.md.",
    "",
  ].join("\n"),
} as const;
const KNOWN_MISSION_EVAL_PROFILES = new Map<string, string>([
  ["juno-agent-literature-2026", "literature"],
  ["juno-agi-literature-2026", "literature"],
  ["juno-axiom-book-2026", "literature"],
]);

export type WorkflowExperimentStatus = "proposed" | "running" | "accepted" | "rejected";

export class WorkflowSelectionPreimageError extends Error {
  readonly code = "WORKFLOW_SELECTION_PREIMAGE_CONFLICT";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowSelectionPreimageError";
  }
}

export type WorkflowSelectionMigrationStatus =
  | "missing"
  | "legacy_v0"
  | "trusted_v1"
  | "unsupported";

export interface WorkflowSelectionMigrationInspection {
  status: WorkflowSelectionMigrationStatus;
  selectionPath: string;
  sha256: string | null;
  byteLength: number | null;
  workflowId: string | null;
  detail: string;
}

export interface WorkflowSelectionMigrationReceipt {
  receiptVersion: typeof WORKFLOW_SELECTION_MIGRATION_RECEIPT_VERSION;
  receiptKind: "workflow-selection-legacy-archive";
  sourceRelativePath: "state/workflow-selection.json";
  archiveRelativePath: string;
  selectionSha256: string;
  selectionByteLength: number;
  legacySchemaVersion: 0;
  legacyWorkflowId: string;
  operatorReason: string;
  archivedAt: string;
}

export interface WorkflowSelectionMigrationResult {
  status: "archived" | "already_archived";
  archivePath: string;
  receiptPath: string;
  receiptSha256: string;
  receipt: WorkflowSelectionMigrationReceipt;
}

export interface WorkflowSelectionMutationDependencies {
  afterPreimageMoved?: (context: {
    targetPath: string;
    quarantinePath: string;
    lockPath: string;
  }) => void;
}

export interface PreviousWorkflowSelection {
  exists: boolean;
  sha256: string | null;
  json: string | null;
}

export interface WorkflowExperimentProposal {
  experimentVersion: typeof WORKFLOW_EXPERIMENT_VERSION;
  experimentId: string;
  targetMissionId: string;
  experimentMissionId: string;
  sourcePhaseId: string;
  baselineWorkflowId: string;
  baselineWorkflowSha256: string;
  candidateWorkflowId: string;
  candidateWorkflowSha256: string;
  promptSha256ByTemplate: Record<string, string>;
  fixtureSha256: string;
  requiredEpisodes: number;
  previousSelection: PreviousWorkflowSelection;
  createdAt: string;
}

export interface WorkflowExperimentRunningRecord {
  recordVersion: 1;
  experimentId: string;
  proposalSha256: string;
  startedAt: string;
}

export interface WorkflowArmMetrics {
  completedEpisodes: number;
  verifyPasses: number;
  verifyFailures: number;
  observedSlots: number;
  failures: number;
  revisions: number;
  safetyBlocks: number;
  retries: number;
  verifyPassRate: number;
  failureRate: number;
  reviseRate: number;
  averageRetries: number;
  averageSlots: number;
}

export interface WorkflowExperimentMetrics {
  baseline: WorkflowArmMetrics;
  candidate: WorkflowArmMetrics;
}

export interface WorkflowExperimentDecisionReceipt {
  receiptVersion: typeof WORKFLOW_EXPERIMENT_RECEIPT_VERSION;
  experimentId: string;
  proposalSha256: string;
  decision: "accepted" | "rejected";
  reason: string;
  metrics: WorkflowExperimentMetrics;
  evidence: RunEvidence[];
  evidenceSha256: string;
  fixtureSha256: string;
  decidedAt: string;
}

export interface WorkflowExperimentSnapshot {
  proposal: WorkflowExperimentProposal;
  proposalSha256: string;
  status: WorkflowExperimentStatus;
  running: WorkflowExperimentRunningRecord | null;
  decision: WorkflowExperimentDecisionReceipt | null;
  metrics: WorkflowExperimentMetrics;
}

export interface ProposeWorkflowExperimentInput {
  targetMissionId: string;
  baselineWorkflowId: string;
  candidateWorkflowId: string;
  sourcePhaseId?: string;
  requiredEpisodes?: number;
  experimentId?: string;
}

export interface RunEvidence {
  runId: string;
  missionId: string;
  arm: WorkflowExperimentArm;
  episode: number;
  runKind: RunKind;
  workflowId: string;
  promptSha256: string;
  revisionOf: string | null;
  revisionAttempt: number | null;
  fixtureSha256: string;
  observed: boolean;
  success: boolean;
  failure: boolean;
  revised: boolean;
  safetyBlocked: boolean;
  verifyPass: boolean;
  retryCount: number;
  queueItemSha256: string;
  manifestSha256: string;
  checkpointSha256: string | null;
  safetySha256: string | null;
  executionArtifactSha256: string | null;
  eventsSha256: string | null;
}

const PROPOSAL_KEYS = [
  "baselineWorkflowId",
  "baselineWorkflowSha256",
  "candidateWorkflowId",
  "candidateWorkflowSha256",
  "createdAt",
  "experimentId",
  "experimentMissionId",
  "experimentVersion",
  "fixtureSha256",
  "previousSelection",
  "promptSha256ByTemplate",
  "requiredEpisodes",
  "sourcePhaseId",
  "targetMissionId",
] as const;
const RUNNING_KEYS = ["experimentId", "proposalSha256", "recordVersion", "startedAt"] as const;
const DECISION_KEYS = [
  "decidedAt",
  "decision",
  "evidence",
  "evidenceSha256",
  "experimentId",
  "fixtureSha256",
  "metrics",
  "proposalSha256",
  "reason",
  "receiptVersion",
] as const;
const EVIDENCE_KEYS = [
  "arm",
  "checkpointSha256",
  "episode",
  "eventsSha256",
  "executionArtifactSha256",
  "failure",
  "fixtureSha256",
  "manifestSha256",
  "missionId",
  "observed",
  "promptSha256",
  "queueItemSha256",
  "retryCount",
  "revisionAttempt",
  "revisionOf",
  "revised",
  "runId",
  "runKind",
  "safetyBlocked",
  "safetySha256",
  "success",
  "verifyPass",
  "workflowId",
] as const;

interface SelectionLeaseState {
  token: string;
  pid: number;
  acquiredAt: number;
}

interface SelectionLease extends SelectionLeaseState {
  lockPath: string;
}

interface FileSnapshot {
  raw: string;
  sha256: string;
  state: SelectionLeaseState | null;
  kind: "file" | "symlink" | "other";
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeMs: number;
  birthtimeMs: number;
}

interface ExperimentFixtureTemplate {
  fixtureVersion: 1 | 2;
  files: Record<string, string>;
}
const METRIC_KEYS = [
  "averageRetries",
  "averageSlots",
  "completedEpisodes",
  "failureRate",
  "failures",
  "observedSlots",
  "retries",
  "reviseRate",
  "revisions",
  "safetyBlocks",
  "verifyFailures",
  "verifyPassRate",
  "verifyPasses",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validatePromptSha256Map(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("promptSha256ByTemplate must be an object");
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 32) {
    throw new Error("promptSha256ByTemplate must contain 1-32 templates");
  }
  const normalized: Record<string, string> = {};
  for (const [template, sha256] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    assertSafeId(template, "promptSha256ByTemplate template");
    assertSha(sha256, `promptSha256ByTemplate.${template}`);
    normalized[template] = sha256;
  }
  return normalized;
}

function readExperimentPromptSha256(workbench: string, template: string): string {
  return readPromptTemplateSnapshot(workbench, template).sha256;
}

function promptSha256MapFor(
  workbench: string,
  targetMissionId: string,
  workflows: Array<ReturnType<typeof loadWorkflow>>,
): Record<string, string> {
  const templates = new Set(workflows.flatMap((workflow) => workflow.slots.map((slot) => slot.prompt)));
  const promptEntries = [...templates]
    .sort()
    .map((template) => [template, readExperimentPromptSha256(workbench, template)] as const);
  if (targetMissionId === AXIOM_BOOK_MISSION_ID) {
    return validatePromptSha256Map(Object.fromEntries(
      [
        ...promptEntries,
        ...Object.entries(LITERATURE_CANARY_PROMPT_TEXT).map(([template, content]) => [
          template,
          hashText(content),
        ] as const),
      ],
    ));
  }
  return validatePromptSha256Map(Object.fromEntries(promptEntries));
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be a safe non-empty id`);
  }
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} is not SHA-256`);
}

function assertIso(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function validateExperimentRootDirectory(workbench: string): string {
  const lexicalStateRoot = path.join(path.resolve(workbench), "state");
  if (!pathEntryExists(lexicalStateRoot)) {
    return path.join(lexicalStateRoot, "workflow-experiments");
  }
  const stateRoot = validateWorkbenchRootDirectory(workbench, "state");
  const root = path.join(stateRoot, "workflow-experiments");
  if (!pathEntryExists(root)) return root;
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Workflow experiment state root must be a non-link directory: ${root}`);
  }
  const actual = realpathSync.native(root);
  if (!sameCanonicalPath(actual, root)) {
    throw new Error(`Workflow experiment state root escapes canonical containment: ${root}`);
  }
  return actual;
}

function ensureExperimentRootDirectory(workbench: string): string {
  const stateRoot = ensureWorkbenchRootDirectory(workbench, "state");
  const root = path.join(stateRoot, "workflow-experiments");
  if (!pathEntryExists(root)) mkdirSync(root);
  return validateExperimentRootDirectory(workbench);
}

function experimentRoot(workbench: string): string {
  return validateExperimentRootDirectory(workbench);
}

function experimentKey(experimentId: string): string {
  assertSafeId(experimentId, "experimentId");
  return hashText(experimentId);
}

export function workflowExperimentPaths(workbench: string, experimentId: string): {
  proposal: string;
  running: string;
  decision: string;
} {
  const key = experimentKey(experimentId);
  const root = experimentRoot(workbench);
  return {
    proposal: path.join(root, `${key}.proposal.json`),
    running: path.join(root, `${key}.running.json`),
    decision: path.join(root, `${key}.decision.json`),
  };
}

function readControlText(filePath: string, label: string, maxBytes: number): string {
  return readExclusiveControlText(filePath, label, maxBytes).text;
}

function createOnceJson(
  filePath: string,
  value: unknown,
  label: string,
  maxBytes: number,
): void {
  const rootStat = lstatSync(path.dirname(filePath));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} directory must be a regular directory`);
  }
  const text = canonicalJson(value);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit: ${filePath}`);
  }
  try {
    writeFileSync(filePath, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readControlText(filePath, label, maxBytes);
    if (existing !== text) throw new Error(`${label} already exists with conflicting evidence`);
  }
}

function parseLeaseState(raw: string): SelectionLeaseState | null {
  try {
    const value = JSON.parse(raw) as Partial<SelectionLeaseState>;
    if (
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      !Number.isFinite(value.acquiredAt)
    ) {
      return null;
    }
    return value as SelectionLeaseState;
  } catch {
    return null;
  }
}

function readFileSnapshot(
  target: string,
  label: string,
  maxBytes: number,
): FileSnapshot | null {
  let before;
  try {
    before = lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const control = readExclusiveControlText(target, label, maxBytes);
  const after = lstatSync(target, { bigint: true });
  const kind = after.isFile() ? "file" : after.isSymbolicLink() ? "symlink" : "other";
  if (
    kind !== "file" ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.nlink !== after.nlink ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    after.size !== BigInt(control.byteLength)
  ) {
    throw new Error(`${label} changed while taking a snapshot: ${target}`);
  }
  return {
    raw: control.text,
    sha256: control.sha256,
    state: parseLeaseState(control.text),
    kind,
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    mtimeMs: Number(after.mtimeMs),
    birthtimeMs: Number(after.birthtimeMs),
  };
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.raw === right.raw &&
    left.sha256 === right.sha256 &&
    left.kind === right.kind &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.birthtimeMs === right.birthtimeMs;
}

function readSelectionSnapshot(target: string, label = "Workflow selection"): FileSnapshot | null {
  return readFileSnapshot(target, label, MAX_SELECTION_BYTES);
}

function readSelectionLeaseSnapshot(target: string): FileSnapshot | null {
  return readFileSnapshot(target, "Workflow selection lease", MAX_SELECTION_LOCK_BYTES);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function createLeaseExclusive(target: string): SelectionLease | null {
  const state: SelectionLeaseState = {
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: Date.now(),
  };
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(target, "wx");
    created = true;
    writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
    return { lockPath: target, ...state };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    if (created) {
      try {
        unlinkSync(target);
      } catch {
        // An incomplete lock remains fail-closed until stale recovery.
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function restoreQuarantine(
  quarantine: string,
  target: string,
  label: string,
  maxBytes: number,
): void {
  try {
    if (!readFileSnapshot(target, label, maxBytes)) renameSync(quarantine, target);
  } catch {
    // Preserve both paths for manual recovery instead of overwriting unknown ownership.
  }
}

function removeSnapshot(target: string, observed: FileSnapshot): boolean {
  const current = readSelectionLeaseSnapshot(target);
  if (!current || !sameFileSnapshot(observed, current)) return false;
  const quarantine = `${target}.quarantine-${process.pid}-${randomUUID()}`;
  try {
    renameSync(target, quarantine);
    const moved = readSelectionLeaseSnapshot(quarantine);
    if (!moved || !sameFileSnapshot(observed, moved)) {
      restoreQuarantine(
        quarantine,
        target,
        "Workflow selection lease",
        MAX_SELECTION_LOCK_BYTES,
      );
      return false;
    }
    unlinkSync(quarantine);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    restoreQuarantine(
      quarantine,
      target,
      "Workflow selection lease",
      MAX_SELECTION_LOCK_BYTES,
    );
    throw error;
  }
}

function staleLease(snapshot: FileSnapshot): boolean {
  const ageMs = Date.now() - Math.max(snapshot.mtimeMs, snapshot.state?.acquiredAt ?? 0);
  if (ageMs <= SELECTION_LOCK_STALE_MS) return false;
  if (ageMs > SELECTION_LOCK_MAX_OWNER_AGE_MS) return true;
  return !snapshot.state || !processAlive(snapshot.state.pid);
}

function recoverStaleLease(target: string): boolean {
  const observed = readSelectionLeaseSnapshot(target);
  if (!observed) return true;
  return staleLease(observed) && removeSnapshot(target, observed);
}

export function workflowSelectionLockPath(workbench: string): string {
  return path.join(workbench, "state", "workflow-selection.lock.json");
}

function acquireSelectionLease(workbench: string): SelectionLease | null {
  const stateDir = ensureWorkbenchRootDirectory(workbench, "state");
  const target = path.join(stateDir, "workflow-selection.lock.json");
  const immediate = createLeaseExclusive(target);
  if (immediate) return immediate;

  const guardTarget = `${target}.recovery`;
  let guard = createLeaseExclusive(guardTarget);
  if (!guard && recoverStaleLease(guardTarget)) guard = createLeaseExclusive(guardTarget);
  if (!guard) return null;
  let acquired: SelectionLease | null = null;
  try {
    if (!recoverStaleLease(target)) return null;
    acquired = createLeaseExclusive(target);
    return acquired;
  } finally {
    if (!releaseSelectionLease(guard)) {
      if (acquired) releaseSelectionLease(acquired);
      throw new Error(`Lost workflow selection recovery guard ownership: ${guardTarget}`);
    }
  }
}

function releaseSelectionLease(lease: SelectionLease): boolean {
  const observed = readSelectionLeaseSnapshot(lease.lockPath);
  if (
    !observed?.state ||
    observed.state.token !== lease.token ||
    observed.state.pid !== lease.pid
  ) {
    return false;
  }
  return removeSnapshot(lease.lockPath, observed);
}

function assertSelectionLeaseOwned(lease: SelectionLease): void {
  const state = readSelectionLeaseSnapshot(lease.lockPath)?.state;
  if (!state || state.token !== lease.token || state.pid !== lease.pid) {
    throw new Error("Lost workflow selection lease ownership");
  }
}

function withSelectionLease<T>(workbench: string, operation: (lease: SelectionLease) => T): T {
  const lease = acquireSelectionLease(workbench);
  if (!lease) throw new Error("Workflow selection mutation is busy");
  try {
    return operation(lease);
  } finally {
    if (!releaseSelectionLease(lease)) {
      throw new Error("Lost workflow selection lease ownership during release");
    }
  }
}

function workflowSelectionRecoveryArtifacts(workbench: string): string[] {
  const lexicalStateDir = path.join(path.resolve(workbench), "state");
  if (!pathEntryExists(lexicalStateDir)) return [];
  let stateDir: string;
  try {
    stateDir = validateWorkbenchRootDirectory(workbench, "state");
  } catch (error) {
    throw new WorkflowSelectionPreimageError(
      "Workflow selection state directory is not trusted",
      { cause: error },
    );
  }
  const target = path.join(stateDir, "workflow-selection.json");

  const targetName = path.basename(target);
  const lockName = path.basename(workflowSelectionLockPath(workbench));
  return readdirSync(stateDir).filter((name) =>
    name.startsWith(`${targetName}.preimage-`) ||
    name.startsWith(`${targetName}.rollback-`) ||
    (name.startsWith(`.${targetName}.`) && name.endsWith(".tmp")) ||
    name.startsWith(`${lockName}.quarantine-`) ||
    name === `${lockName}.recovery`
  ).sort();
}

function assertNoWorkflowSelectionRecoveryState(workbench: string): void {
  const artifacts = workflowSelectionRecoveryArtifacts(workbench);
  if (artifacts.length > 0) {
    throw new WorkflowSelectionPreimageError(
      `Workflow selection has orphaned preimage or recovery state: ${artifacts.join(", ")}`,
    );
  }
}

function installTempExclusive(temp: string, target: string): void {
  linkSync(temp, target);
  unlinkSync(temp);
}

function replaceSelectionLocked(
  lease: SelectionLease,
  filePath: string,
  text: string,
  expectedText: string | null,
  dependencies: WorkflowSelectionMutationDependencies = {},
): void {
  assertSelectionLeaseOwned(lease);
  const observed = readSelectionSnapshot(filePath);
  if (expectedText === null ? observed !== null : observed?.kind !== "file" || observed.raw !== expectedText) {
    throw new Error("Workflow selection changed concurrently");
  }
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let quarantine: string | null = null;
  let installed = false;
  try {
    writeFileSync(temp, text, { encoding: "utf8", flag: "wx" });
    assertSelectionLeaseOwned(lease);
    if (observed) {
      const current = readSelectionSnapshot(filePath);
      if (!current || !sameFileSnapshot(observed, current)) {
        throw new Error("Workflow selection changed before commit");
      }
      quarantine = `${filePath}.preimage-${process.pid}-${randomUUID()}`;
      renameSync(filePath, quarantine);
      const moved = readSelectionSnapshot(quarantine, "Workflow selection preimage");
      if (!moved || !sameFileSnapshot(observed, moved)) {
        throw new Error("Workflow selection preimage changed during commit");
      }
      dependencies.afterPreimageMoved?.({
        targetPath: filePath,
        quarantinePath: quarantine,
        lockPath: lease.lockPath,
      });
    }
    assertSelectionLeaseOwned(lease);
    try {
      installTempExclusive(temp, filePath);
      installed = true;
    } catch (error) {
      throw new Error("Concurrent workflow selection writer won the commit", { cause: error });
    }
    const installedSnapshot = readSelectionSnapshot(filePath);
    if (!installedSnapshot || installedSnapshot.kind !== "file" || installedSnapshot.raw !== text) {
      throw new Error("Workflow selection changed during commit verification");
    }
    if (quarantine) {
      unlinkSync(quarantine);
      quarantine = null;
    }
  } catch (error) {
    if (quarantine && !installed && !readSelectionSnapshot(filePath)) {
      try {
        linkSync(quarantine, filePath);
        unlinkSync(quarantine);
        quarantine = null;
        const restored = readSelectionSnapshot(filePath);
        if (!restored || !observed || !sameFileSnapshot(observed, restored)) {
          throw new Error("restored selection does not match the preimage");
        }
      } catch (recoveryError) {
        throw new Error("Workflow selection preimage recovery failed", {
          cause: new AggregateError([error, recoveryError]),
        });
      }
    }
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

function removeSelectionLocked(
  lease: SelectionLease,
  filePath: string,
  expectedText: string,
): void {
  assertSelectionLeaseOwned(lease);
  const observed = readSelectionSnapshot(filePath);
  if (!observed || observed.kind !== "file" || observed.raw !== expectedText) {
    throw new Error("Workflow selection changed before rollback");
  }
  let quarantine: string | null = `${filePath}.rollback-${process.pid}-${randomUUID()}`;
  try {
    renameSync(filePath, quarantine);
    const moved = readSelectionSnapshot(quarantine, "Workflow selection rollback preimage");
    if (!moved || !sameFileSnapshot(observed, moved)) {
      throw new Error("Workflow selection changed during rollback");
    }
    assertSelectionLeaseOwned(lease);
    unlinkSync(quarantine);
    quarantine = null;
    if (readSelectionSnapshot(filePath)) {
      throw new Error("Concurrent workflow selection writer appeared during rollback");
    }
  } catch (error) {
    if (quarantine) {
      restoreQuarantine(
        quarantine,
        filePath,
        "Workflow selection rollback preimage",
        MAX_SELECTION_BYTES,
      );
      if (!readSelectionSnapshot(filePath)) {
        throw new Error("Workflow selection rollback recovery failed", { cause: error });
      }
    }
    throw error;
  }
}

function readPreviousSelection(
  workbench: string,
  targetMissionId: string,
  baselineWorkflowId: string,
): PreviousWorkflowSelection {
  const selection = readTrustedWorkflowSelectionSnapshotLocked(workbench, targetMissionId);
  if (!selection) return { exists: false, sha256: null, json: null };
  if (selection.workflowId !== baselineWorkflowId) {
    throw new WorkflowSelectionPreimageError(
      `Experiment baseline must match the trusted active workflow: ${selection.workflowId}`,
    );
  }
  return { exists: true, sha256: selection.sha256, json: selection.raw };
}

function samePreviousSelection(
  left: PreviousWorkflowSelection,
  right: PreviousWorkflowSelection,
): boolean {
  return left.exists === right.exists && left.sha256 === right.sha256 && left.json === right.json;
}

function assertProposalPreviousSelectionCurrentLocked(
  workbench: string,
  proposal: Pick<
    WorkflowExperimentProposal,
    "baselineWorkflowId" | "previousSelection" | "targetMissionId"
  >,
): PreviousWorkflowSelection {
  const current = readPreviousSelection(
    workbench,
    proposal.targetMissionId,
    proposal.baselineWorkflowId,
  );
  if (!samePreviousSelection(current, proposal.previousSelection)) {
    throw new WorkflowSelectionPreimageError(
      "Workflow selection changed since experiment proposal; refusing stale experiment",
    );
  }
  return current;
}

function validatePreviousSelection(
  value: unknown,
  targetMissionId?: string,
): PreviousWorkflowSelection {
  if (!isRecord(value)) throw new Error("Experiment previousSelection must be an object");
  assertExactKeys(value, ["exists", "json", "sha256"], "Experiment previousSelection");
  if (typeof value.exists !== "boolean") throw new Error("previousSelection.exists must be boolean");
  if (value.exists) {
    assertSha(value.sha256, "previousSelection.sha256");
    if (
      typeof value.json !== "string" ||
      Buffer.byteLength(value.json, "utf8") > MAX_SELECTION_BYTES ||
      hashText(value.json) !== value.sha256
    ) {
      throw new Error("previousSelection JSON hash mismatch");
    }
    try {
      const parsed = JSON.parse(value.json);
      if (!isRecord(parsed)) throw new Error("not an object");
      if (targetMissionId && parsed.missionId !== targetMissionId) {
        throw new Error("previous selection belongs to another mission");
      }
    } catch (error) {
      throw new Error("previousSelection JSON is malformed", { cause: error });
    }
  } else if (value.sha256 !== null || value.json !== null) {
    throw new Error("Missing previousSelection must use null sha256/json");
  }
  return value as unknown as PreviousWorkflowSelection;
}

function validateProposal(value: unknown, expectedId?: string): WorkflowExperimentProposal {
  if (!isRecord(value)) throw new Error("Workflow experiment proposal must be an object");
  assertExactKeys(value, PROPOSAL_KEYS, "Workflow experiment proposal");
  if (value.experimentVersion !== WORKFLOW_EXPERIMENT_VERSION) {
    throw new Error(`Unsupported workflow experiment version: ${String(value.experimentVersion)}`);
  }
  for (const key of [
    "experimentId",
    "targetMissionId",
    "experimentMissionId",
    "sourcePhaseId",
  ] as const) assertSafeId(value[key], key);
  if (expectedId && value.experimentId !== expectedId) throw new Error("Experiment id mismatch");
  if (typeof value.baselineWorkflowId !== "string" || typeof value.candidateWorkflowId !== "string") {
    throw new Error("Experiment workflow ids must be strings");
  }
  if (value.baselineWorkflowId === value.candidateWorkflowId) {
    throw new Error("Baseline and candidate workflows must differ");
  }
  assertSha(value.baselineWorkflowSha256, "baselineWorkflowSha256");
  assertSha(value.candidateWorkflowSha256, "candidateWorkflowSha256");
  validatePromptSha256Map(value.promptSha256ByTemplate);
  assertSha(value.fixtureSha256, "fixtureSha256");
  if (
    !Number.isSafeInteger(value.requiredEpisodes) ||
    (value.requiredEpisodes as number) < MIN_EPISODES ||
    (value.requiredEpisodes as number) > MAX_EPISODES
  ) {
    throw new Error(`requiredEpisodes must be between ${MIN_EPISODES} and ${MAX_EPISODES}`);
  }
  assertIso(value.createdAt, "createdAt");
  validatePreviousSelection(value.previousSelection, value.targetMissionId as string);
  if (
    value.experimentMissionId !==
    `juno-workflow-canary-${hashText(value.experimentId as string).slice(0, 16)}`
  ) {
    throw new Error("Experiment mission id is not derived from experiment id");
  }
  if (
    value.fixtureSha256 !== fixtureTemplateSha256({
      experimentId: value.experimentId as string,
      targetMissionId: value.targetMissionId as string,
      sourcePhaseId: value.sourcePhaseId as string,
    })
  ) {
    throw new Error("Experiment fixture hash is invalid");
  }
  return value as unknown as WorkflowExperimentProposal;
}

function readProposal(workbench: string, experimentId: string): { proposal: WorkflowExperimentProposal; text: string; sha256: string } {
  const proposalPath = workflowExperimentPaths(workbench, experimentId).proposal;
  const snapshot = readFileSnapshot(
    proposalPath,
    "Workflow experiment proposal",
    MAX_CONTROL_RECORD_BYTES,
  );
  if (!snapshot) throw new Error(`Workflow experiment does not exist: ${experimentId}`);
  const text = snapshot.raw;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error("Workflow experiment proposal is unreadable", { cause: error });
  }
  return { proposal: validateProposal(raw, experimentId), text, sha256: snapshot.sha256 };
}

function validateRunning(value: unknown, proposalSha256: string, experimentId: string): WorkflowExperimentRunningRecord {
  if (!isRecord(value)) throw new Error("Workflow experiment running record must be an object");
  assertExactKeys(value, RUNNING_KEYS, "Workflow experiment running record");
  if (value.recordVersion !== 1 || value.experimentId !== experimentId || value.proposalSha256 !== proposalSha256) {
    throw new Error("Workflow experiment running record binding is invalid");
  }
  assertIso(value.startedAt, "startedAt");
  return value as unknown as WorkflowExperimentRunningRecord;
}

function readRunning(workbench: string, experimentId: string, proposalSha256: string): WorkflowExperimentRunningRecord | null {
  const runningPath = workflowExperimentPaths(workbench, experimentId).running;
  const snapshot = readFileSnapshot(
    runningPath,
    "Workflow experiment running record",
    MAX_CONTROL_RECORD_BYTES,
  );
  if (!snapshot) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(snapshot.raw);
  } catch (error) {
    throw new Error("Workflow experiment running record is unreadable", { cause: error });
  }
  return validateRunning(raw, proposalSha256, experimentId);
}

function validateArmMetrics(value: unknown, label: string): WorkflowArmMetrics {
  if (!isRecord(value)) throw new Error(`${label} metrics must be an object`);
  assertExactKeys(value, METRIC_KEYS, `${label} metrics`);
  for (const key of METRIC_KEYS) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || (value[key] as number) < 0) {
      throw new Error(`${label}.${key} must be a non-negative finite number`);
    }
  }
  return value as unknown as WorkflowArmMetrics;
}

function validateMetrics(value: unknown): WorkflowExperimentMetrics {
  if (!isRecord(value)) throw new Error("Experiment metrics must be an object");
  assertExactKeys(value, ["baseline", "candidate"], "Experiment metrics");
  return {
    baseline: validateArmMetrics(value.baseline, "baseline"),
    candidate: validateArmMetrics(value.candidate, "candidate"),
  };
}

function validateEvidence(
  value: unknown,
  proposal: WorkflowExperimentProposal,
): RunEvidence[] {
  if (!Array.isArray(value)) throw new Error("Workflow experiment evidence must be an array");
  const expectedById = new Map(compiledItems(proposal).map((item) => [item.id, item]));
  const seen = new Set<string>();
  const evidence = value.map((entry, index): RunEvidence => {
    if (!isRecord(entry)) throw new Error(`Experiment evidence[${index}] must be an object`);
    assertExactKeys(entry, EVIDENCE_KEYS, `Experiment evidence[${index}]`);
    assertSafeId(entry.runId, `evidence[${index}].runId`);
    if (seen.has(entry.runId)) throw new Error(`Duplicate experiment evidence run: ${entry.runId}`);
    seen.add(entry.runId);
    let expected = expectedById.get(entry.runId);
    if (!expected) {
      if (typeof entry.revisionOf !== "string" || !Number.isSafeInteger(entry.revisionAttempt)) {
        throw new Error(`Unexpected experiment evidence run: ${entry.runId}`);
      }
      const parent = expectedById.get(entry.revisionOf);
      if (!parent || !(["review", "debate", "vote"] as unknown[]).includes(parent.run_kind)) {
        throw new Error(`Experiment revision parent is invalid: ${entry.runId}`);
      }
      if (entry.runId !== revisionFixRunId(entry.revisionOf, entry.revisionAttempt as number)) {
        throw new Error(`Experiment revision run id is invalid: ${entry.runId}`);
      }
      expected = buildReviseImplementItem(
        parent,
        entry.revisionAttempt as number,
        [],
        revisionPromptBinding(proposal),
      );
    } else if (entry.revisionOf !== null || entry.revisionAttempt !== null) {
      throw new Error(`Static experiment evidence cannot claim revision lineage: ${entry.runId}`);
    }
    if (entry.arm !== "baseline" && entry.arm !== "candidate") {
      throw new Error(`evidence[${index}].arm is invalid`);
    }
    if (
      !Number.isSafeInteger(entry.episode) ||
      (entry.episode as number) < 1 ||
      (entry.episode as number) > proposal.requiredEpisodes ||
      entry.episode !== expected.experiment_episode
    ) {
      throw new Error(`evidence[${index}].episode is invalid`);
    }
    if (
      entry.arm !== expected.experiment_arm ||
      entry.missionId !== expected.mission_id ||
      entry.workflowId !== expected.workflow_id ||
      entry.runKind !== expected.run_kind ||
      entry.fixtureSha256 !== proposal.fixtureSha256 ||
      entry.promptSha256 !== expected.experiment_prompt_sha256 ||
      entry.revisionOf !== (expected.revision_of ?? null) ||
      entry.revisionAttempt !== (expected.revision_attempt ?? null)
    ) {
      throw new Error(`Experiment evidence binding is invalid: ${entry.runId}`);
    }
    for (const key of [
      "observed",
      "success",
      "failure",
      "revised",
      "safetyBlocked",
      "verifyPass",
    ] as const) {
      if (typeof entry[key] !== "boolean") {
        throw new Error(`evidence[${index}].${key} must be boolean`);
      }
    }
    if (
      !Number.isSafeInteger(entry.retryCount) ||
      (entry.retryCount as number) < 0 ||
      (entry.retryCount as number) > 20
    ) {
      throw new Error(`evidence[${index}].retryCount is invalid`);
    }
    assertSha(entry.queueItemSha256, `evidence[${index}].queueItemSha256`);
    assertSha(entry.manifestSha256, `evidence[${index}].manifestSha256`);
    assertSha(entry.promptSha256, `evidence[${index}].promptSha256`);
    for (const key of [
      "checkpointSha256",
      "safetySha256",
      "executionArtifactSha256",
      "eventsSha256",
    ] as const) {
      if (entry[key] !== null) assertSha(entry[key], `evidence[${index}].${key}`);
    }
    if (
      entry.success === entry.failure && entry.observed ||
      (!entry.observed && (entry.success || entry.failure)) ||
      (entry.verifyPass && (entry.runKind !== "verify" || !entry.success)) ||
      (entry.executionArtifactSha256 === null) !== (entry.eventsSha256 === null) ||
      (entry.observed && entry.executionArtifactSha256 === null)
    ) {
      throw new Error(`Experiment evidence outcome is inconsistent: ${entry.runId}`);
    }
    return entry as unknown as RunEvidence;
  });
  const ids = evidence.map((entry) => entry.runId);
  if (JSON.stringify(ids) !== JSON.stringify([...ids].sort((a, b) => a.localeCompare(b)))) {
    throw new Error("Workflow experiment evidence must be sorted by runId");
  }
  const attemptsByParent = new Map<string, number[]>();
  for (const entry of evidence) {
    if (!entry.revisionOf || entry.revisionAttempt === null) continue;
    const parentEvidence = evidence.find((candidate) => candidate.runId === entry.revisionOf);
    if (!parentEvidence?.revised) {
      throw new Error(`Experiment revision parent did not request REVISE: ${entry.runId}`);
    }
    const attempts = attemptsByParent.get(entry.revisionOf) ?? [];
    attempts.push(entry.revisionAttempt);
    attemptsByParent.set(entry.revisionOf, attempts);
  }
  for (const [parent, attempts] of attemptsByParent) {
    const ordered = [...attempts].sort((a, b) => a - b);
    if (ordered.some((attempt, index) => attempt !== index + 1)) {
      throw new Error(`Experiment revision attempts are not contiguous for ${parent}`);
    }
  }
  return evidence;
}

function validateRollbackReceiptEvidence(
  value: unknown,
  proposal: WorkflowExperimentProposal,
): RunEvidence[] {
  if (!Array.isArray(value)) throw new Error("Workflow experiment evidence must be an array");
  const seen = new Set<string>();
  const promptHashes = new Set(Object.values(proposal.promptSha256ByTemplate));
  const experimentKey = hashText(proposal.experimentId).slice(0, 12);
  const evidence = value.map((entry, index): RunEvidence => {
    if (!isRecord(entry)) throw new Error(`Experiment evidence[${index}] must be an object`);
    assertExactKeys(entry, EVIDENCE_KEYS, `Experiment evidence[${index}]`);
    assertSafeId(entry.runId, `evidence[${index}].runId`);
    if (seen.has(entry.runId)) throw new Error(`Duplicate experiment evidence run: ${entry.runId}`);
    seen.add(entry.runId);
    if (entry.arm !== "baseline" && entry.arm !== "candidate") {
      throw new Error(`evidence[${index}].arm is invalid`);
    }
    if (
      !Number.isSafeInteger(entry.episode) ||
      (entry.episode as number) < 1 ||
      (entry.episode as number) > proposal.requiredEpisodes
    ) {
      throw new Error(`evidence[${index}].episode is invalid`);
    }
    if (!(["implement", "review", "debate", "vote", "verify"] as unknown[]).includes(entry.runKind)) {
      throw new Error(`evidence[${index}].runKind is invalid`);
    }
    const arm = entry.arm as WorkflowExperimentArm;
    const episode = entry.episode as number;
    const expectedWorkflowId = arm === "baseline"
      ? proposal.baselineWorkflowId
      : proposal.candidateWorkflowId;
    if (
      entry.missionId !== workflowExperimentSampleMissionId(proposal, arm, episode) ||
      entry.workflowId !== expectedWorkflowId ||
      entry.fixtureSha256 !== proposal.fixtureSha256 ||
      typeof entry.promptSha256 !== "string" ||
      !promptHashes.has(entry.promptSha256)
    ) {
      throw new Error(`Experiment rollback evidence binding is invalid: ${entry.runId}`);
    }

    const hasRevisionOf = entry.revisionOf !== null;
    const hasRevisionAttempt = entry.revisionAttempt !== null;
    if (hasRevisionOf !== hasRevisionAttempt) {
      throw new Error(`Experiment revision lineage is incomplete: ${entry.runId}`);
    }
    if (hasRevisionOf) {
      if (
        typeof entry.revisionOf !== "string" ||
        !Number.isSafeInteger(entry.revisionAttempt) ||
        entry.runKind !== "implement" ||
        entry.runId !== revisionFixRunId(entry.revisionOf, entry.revisionAttempt as number)
      ) {
        throw new Error(`Experiment revision run binding is invalid: ${entry.runId}`);
      }
    } else {
      const armKey = arm === "baseline" ? "b" : "c";
      const prefix = `wfexp-${experimentKey}-${armKey}${episode}-`;
      if (!entry.runId.startsWith(prefix) || !entry.runId.endsWith(`-${String(entry.runKind)}`)) {
        throw new Error(`Static experiment run binding is invalid: ${entry.runId}`);
      }
    }

    for (const key of [
      "observed",
      "success",
      "failure",
      "revised",
      "safetyBlocked",
      "verifyPass",
    ] as const) {
      if (typeof entry[key] !== "boolean") {
        throw new Error(`evidence[${index}].${key} must be boolean`);
      }
    }
    if (
      !Number.isSafeInteger(entry.retryCount) ||
      (entry.retryCount as number) < 0 ||
      (entry.retryCount as number) > 20
    ) {
      throw new Error(`evidence[${index}].retryCount is invalid`);
    }
    assertSha(entry.queueItemSha256, `evidence[${index}].queueItemSha256`);
    assertSha(entry.manifestSha256, `evidence[${index}].manifestSha256`);
    assertSha(entry.promptSha256, `evidence[${index}].promptSha256`);
    for (const key of [
      "checkpointSha256",
      "safetySha256",
      "executionArtifactSha256",
      "eventsSha256",
    ] as const) {
      if (entry[key] !== null) assertSha(entry[key], `evidence[${index}].${key}`);
    }
    if (
      entry.success === entry.failure && entry.observed ||
      (!entry.observed && (entry.success || entry.failure)) ||
      (entry.verifyPass && (entry.runKind !== "verify" || !entry.success)) ||
      (entry.executionArtifactSha256 === null) !== (entry.eventsSha256 === null) ||
      (entry.observed && entry.executionArtifactSha256 === null)
    ) {
      throw new Error(`Experiment evidence outcome is inconsistent: ${entry.runId}`);
    }
    return entry as unknown as RunEvidence;
  });

  const ids = evidence.map((entry) => entry.runId);
  if (JSON.stringify(ids) !== JSON.stringify([...ids].sort((a, b) => a.localeCompare(b)))) {
    throw new Error("Workflow experiment evidence must be sorted by runId");
  }
  const attemptsByParent = new Map<string, number[]>();
  for (const entry of evidence) {
    if (!entry.revisionOf || entry.revisionAttempt === null) continue;
    const parent = evidence.find((candidate) => candidate.runId === entry.revisionOf);
    if (
      !parent?.revised ||
      !(["review", "debate", "vote"] as RunKind[]).includes(parent.runKind) ||
      parent.arm !== entry.arm ||
      parent.episode !== entry.episode ||
      parent.missionId !== entry.missionId ||
      parent.workflowId !== entry.workflowId
    ) {
      throw new Error(`Experiment revision parent binding is invalid: ${entry.runId}`);
    }
    const attempts = attemptsByParent.get(entry.revisionOf) ?? [];
    attempts.push(entry.revisionAttempt);
    attemptsByParent.set(entry.revisionOf, attempts);
  }
  for (const [parent, attempts] of attemptsByParent) {
    const ordered = [...attempts].sort((a, b) => a - b);
    if (ordered.some((attempt, index) => attempt !== index + 1)) {
      throw new Error(`Experiment revision attempts are not contiguous for ${parent}`);
    }
  }
  return evidence;
}

function rollbackReceiptMetricsForArm(
  proposal: WorkflowExperimentProposal,
  arm: WorkflowExperimentArm,
  evidence: RunEvidence[],
  completedEpisodes: number,
): WorkflowArmMetrics {
  if (
    !Number.isSafeInteger(completedEpisodes) ||
    completedEpisodes < 0 ||
    completedEpisodes > proposal.requiredEpisodes
  ) {
    throw new Error(`${arm}.completedEpisodes is invalid`);
  }
  const armEvidence = evidence.filter((entry) => entry.arm === arm);
  const observed = armEvidence.filter((entry) => entry.observed);
  const verifyPasses = new Set(
    armEvidence
      .filter((entry) => entry.observed && entry.runKind === "verify" && entry.verifyPass)
      .map((entry) => entry.episode),
  ).size;
  const failures = observed.filter((entry) => entry.failure).length;
  const revisions = observed.filter((entry) => entry.revised).length;
  const safetyBlocks = armEvidence.filter((entry) => entry.safetyBlocked).length;
  const retries = armEvidence.reduce((sum, entry) => sum + entry.retryCount, 0);
  const observedSlots = observed.length;
  return {
    completedEpisodes,
    verifyPasses,
    verifyFailures: Math.max(0, completedEpisodes - verifyPasses),
    observedSlots,
    failures,
    revisions,
    safetyBlocks,
    retries,
    verifyPassRate: completedEpisodes > 0 ? round(verifyPasses / completedEpisodes) : 0,
    failureRate: observedSlots > 0 ? round(failures / observedSlots) : 0,
    reviseRate: observedSlots > 0 ? round(revisions / observedSlots) : 0,
    averageRetries: completedEpisodes > 0 ? round(retries / completedEpisodes) : 0,
    averageSlots: completedEpisodes > 0 ? round(observedSlots / completedEpisodes) : 0,
  };
}

function validateDecision(
  value: unknown,
  proposal: WorkflowExperimentProposal,
  proposalSha256: string,
): WorkflowExperimentDecisionReceipt {
  if (!isRecord(value)) throw new Error("Workflow experiment decision receipt must be an object");
  assertExactKeys(value, DECISION_KEYS, "Workflow experiment decision receipt");
  if (
    value.receiptVersion !== WORKFLOW_EXPERIMENT_RECEIPT_VERSION ||
    value.experimentId !== proposal.experimentId ||
    value.proposalSha256 !== proposalSha256
  ) {
    throw new Error("Workflow experiment decision receipt binding is invalid");
  }
  if (value.decision !== "accepted" && value.decision !== "rejected") {
    throw new Error("Workflow experiment decision is invalid");
  }
  if (typeof value.reason !== "string" || !value.reason.trim()) throw new Error("Decision reason is empty");
  if (value.fixtureSha256 !== proposal.fixtureSha256) {
    throw new Error("Workflow experiment decision fixture binding is invalid");
  }
  const evidence = validateEvidence(value.evidence, proposal);
  assertSha(value.evidenceSha256, "evidenceSha256");
  if (hashText(JSON.stringify(evidence)) !== value.evidenceSha256) {
    throw new Error("Workflow experiment decision evidence hash mismatch");
  }
  assertIso(value.decidedAt, "decidedAt");
  const metrics = validateMetrics(value.metrics);
  const recomputed = {
    baseline: metricsForArm(proposal, "baseline", evidence),
    candidate: metricsForArm(proposal, "candidate", evidence),
  };
  if (JSON.stringify(metrics) !== JSON.stringify(recomputed)) {
    throw new Error("Workflow experiment decision metrics do not match evidence");
  }
  const evaluation = compareMetrics(proposal, metrics);
  if (
    !evaluation.terminal ||
    evaluation.decision !== value.decision ||
    evaluation.reason !== value.reason
  ) {
    throw new Error("Workflow experiment decision does not follow the comparison policy");
  }
  return value as unknown as WorkflowExperimentDecisionReceipt;
}

interface WorkflowExperimentDecisionSnapshot {
  decision: WorkflowExperimentDecisionReceipt;
  text: string;
  sha256: string;
}

function readCurrentDecisionSnapshot(
  workbench: string,
  proposal: WorkflowExperimentProposal,
  proposalSha256: string,
): WorkflowExperimentDecisionSnapshot | null {
  const decisionPath = workflowExperimentPaths(workbench, proposal.experimentId).decision;
  const snapshot = readFileSnapshot(
    decisionPath,
    "Workflow experiment decision receipt",
    MAX_RUN_EVIDENCE_BYTES,
  );
  if (!snapshot) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(snapshot.raw);
  } catch (error) {
    throw new Error("Workflow experiment decision receipt is unreadable", { cause: error });
  }
  return {
    decision: validateDecision(raw, proposal, proposalSha256),
    text: snapshot.raw,
    sha256: snapshot.sha256,
  };
}

function readDecision(
  workbench: string,
  proposal: WorkflowExperimentProposal,
  proposalSha256: string,
): WorkflowExperimentDecisionReceipt | null {
  return readCurrentDecisionSnapshot(workbench, proposal, proposalSha256)?.decision ?? null;
}

function validateAcceptedRollbackDecision(
  value: unknown,
  proposal: WorkflowExperimentProposal,
  proposalSha256: string,
): WorkflowExperimentDecisionReceipt {
  if (!isRecord(value)) throw new Error("Workflow experiment decision receipt must be an object");
  assertExactKeys(value, DECISION_KEYS, "Workflow experiment decision receipt");
  if (
    value.receiptVersion !== WORKFLOW_EXPERIMENT_RECEIPT_VERSION ||
    value.experimentId !== proposal.experimentId ||
    value.proposalSha256 !== proposalSha256
  ) {
    throw new Error("Workflow experiment decision receipt binding is invalid");
  }
  if (value.decision !== "accepted") {
    throw new Error("Only an accepted workflow experiment can be rolled back");
  }
  if (typeof value.reason !== "string" || !value.reason.trim()) {
    throw new Error("Decision reason is empty");
  }
  if (value.fixtureSha256 !== proposal.fixtureSha256) {
    throw new Error("Workflow experiment decision fixture binding is invalid");
  }
  const evidence = validateRollbackReceiptEvidence(value.evidence, proposal);
  assertSha(value.evidenceSha256, "evidenceSha256");
  if (hashText(JSON.stringify(evidence)) !== value.evidenceSha256) {
    throw new Error("Workflow experiment decision evidence hash mismatch");
  }
  assertIso(value.decidedAt, "decidedAt");
  const metrics = validateMetrics(value.metrics);
  const recomputed = {
    baseline: rollbackReceiptMetricsForArm(
      proposal,
      "baseline",
      evidence,
      metrics.baseline.completedEpisodes,
    ),
    candidate: rollbackReceiptMetricsForArm(
      proposal,
      "candidate",
      evidence,
      metrics.candidate.completedEpisodes,
    ),
  };
  if (JSON.stringify(metrics) !== JSON.stringify(recomputed)) {
    throw new Error("Workflow experiment decision metrics do not match receipt evidence");
  }
  const evaluation = compareMetrics(proposal, metrics);
  if (
    !evaluation.terminal ||
    evaluation.decision !== value.decision ||
    evaluation.reason !== value.reason
  ) {
    throw new Error("Workflow experiment decision does not follow the comparison policy");
  }
  return value as unknown as WorkflowExperimentDecisionReceipt;
}

function readAcceptedRollbackDecision(
  workbench: string,
  proposal: WorkflowExperimentProposal,
  proposalSha256: string,
): WorkflowExperimentDecisionSnapshot | null {
  const decisionPath = workflowExperimentPaths(workbench, proposal.experimentId).decision;
  const snapshot = readFileSnapshot(
    decisionPath,
    "Workflow experiment decision receipt",
    MAX_RUN_EVIDENCE_BYTES,
  );
  if (!snapshot) return null;
  const text = snapshot.raw;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error("Workflow experiment decision receipt is unreadable", { cause: error });
  }
  return {
    decision: validateAcceptedRollbackDecision(raw, proposal, proposalSha256),
    text,
    sha256: snapshot.sha256,
  };
}

function assertCurrentWorkflowHashes(
  workbench: string,
  proposal: WorkflowExperimentProposal,
): void {
  const baseline = loadWorkflow(proposal.baselineWorkflowId);
  const candidate = loadWorkflow(proposal.candidateWorkflowId);
  if (baseline.evalProfile !== candidate.evalProfile) {
    throw new Error("Workflow experiment eval profiles no longer match");
  }
  if (workflowDefinitionSha256(baseline) !== proposal.baselineWorkflowSha256) {
    throw new Error("Baseline workflow changed after experiment proposal");
  }
  if (workflowDefinitionSha256(candidate) !== proposal.candidateWorkflowSha256) {
    throw new Error("Candidate workflow changed after experiment proposal");
  }
  const currentPrompts = promptSha256MapFor(
    workbench,
    proposal.targetMissionId,
    [baseline, candidate],
  );
  if (JSON.stringify(currentPrompts) !== JSON.stringify(proposal.promptSha256ByTemplate)) {
    throw new Error("Workflow experiment prompt bundle changed after proposal");
  }
  if (fixtureTemplateSha256(proposal) !== proposal.fixtureSha256) {
    throw new Error("Workflow experiment fixture template changed after proposal");
  }
}

function revisionPromptBinding(
  proposal: WorkflowExperimentProposal,
): WorkflowExperimentRevisionPromptBinding {
  return Object.freeze({
    experimentId: proposal.experimentId,
    promptSha256ByTemplate: Object.freeze({ ...proposal.promptSha256ByTemplate }),
  });
}

export function readWorkflowExperimentRevisionPromptBinding(
  workbench: string,
  parent: QueueItem,
): WorkflowExperimentRevisionPromptBinding {
  const experimentId = parent.experiment_id;
  if (!experimentId) {
    throw new Error("Workflow experiment revision parent is missing experiment_id");
  }
  const { proposal, sha256: proposalSha256 } = readProposal(workbench, experimentId);
  if (!readRunning(workbench, experimentId, proposalSha256)) {
    throw new Error(`Workflow experiment is not running: ${experimentId}`);
  }
  if (readDecision(workbench, proposal, proposalSha256)) {
    throw new Error(`Terminal workflow experiment cannot create revisions: ${experimentId}`);
  }
  assertCurrentWorkflowHashes(workbench, proposal);
  const expected = compiledItems(proposal).find((item) => item.id === parent.id);
  if (
    !expected ||
    !( ["review", "debate", "vote"] as Array<RunKind | undefined>).includes(expected.run_kind)
  ) {
    throw new Error(`Workflow experiment revision parent is not a compiled review slot: ${parent.id}`);
  }
  if (queueItemFingerprint(parent) !== queueItemFingerprint(expected)) {
    throw new Error(
      `Workflow experiment revision parent binding does not match its immutable proposal: ${parent.id}`,
    );
  }
  return revisionPromptBinding(proposal);
}

function fixtureTemplateFor(input: {
  experimentId: string;
  targetMissionId: string;
  sourcePhaseId: string;
}): ExperimentFixtureTemplate {
  const files: Record<string, string> = {
    "north-star.md": [
      `# Workflow Canary - ${input.experimentId}`,
      "",
      `Evaluate workflow execution quality for source phase \`${input.sourcePhaseId}\` of target mission \`${input.targetMissionId}\`.`,
      "Use only this isolated mission directory. Do not read or modify any other experiment sample.",
      "",
    ].join("\n"),
    "progress.md": [
      "# Workflow Experiment Progress",
      "",
      "| Item | Status |",
      "|---|---|",
      "| isolated canary task | queued |",
      "",
    ].join("\n"),
    "scope-lock.md": [
      "# Scope Lock - Workflow Experiment Sample",
      "",
      "## Allowed Workbench",
      `- \`missions/${FIXTURE_MISSION_TOKEN}/essay.md\``,
      "",
      "## Read-only fixture files",
      "- brief.md",
      "- rubric.md",
      "- north-star.md",
      "- progress.md",
      "- scope-lock.md",
      "",
      "## Forbidden",
      "- Juno repository source",
      "- Other Workbench missions",
      "- Other workflow experiment samples",
      "- Vault",
      "",
    ].join("\n"),
  };
  if (input.targetMissionId !== AXIOM_BOOK_MISSION_ID) {
    return {
      fixtureVersion: 1,
      files: {
        ...files,
        "scope-lock.md": [
          "# Scope Lock - Workflow Experiment Sample",
          "",
          "## Allowed Workbench",
          `- \`missions/${FIXTURE_MISSION_TOKEN}/**\``,
          "",
          "## Forbidden",
          "- Juno repository source",
          "- Other Workbench missions",
          "- Other workflow experiment samples",
          "- Vault",
          "",
        ].join("\n"),
      },
    };
  }
  return {
    fixtureVersion: 2,
    files: {
      ...files,
      "brief.md": [
        "# Source Capsules",
        "",
        "[S1] A useful oversight claim must name an observable failure condition; otherwise apparent success cannot falsify the claim.",
        "",
        "[S2] Append-only decision logs let an independent reviewer reconstruct which evidence, policy, and uncertainty estimate produced an action.",
        "",
        "[S3] Distribution shift can invalidate a monitor that passed earlier tests, so deployment gates need explicit re-evaluation triggers.",
        "",
      ].join("\n"),
      "rubric.md": [
        "# Literature Canary Rubric",
        "",
        "The final essay.md must:",
        "- contain 450-900 English words;",
        "- contain sections named Thesis, Argument, Counterargument, and Conclusion;",
        "- cite [S1], [S2], and [S3] in substantive sentences;",
        "- make a falsifiable thesis about auditable AI oversight;",
        "- answer one serious counterargument;",
        "- avoid external citations and unsupported numerical claims.",
        "",
      ].join("\n"),
      "essay.md": [
        "# Auditable Oversight",
        "",
        "This initial draft is intentionally incomplete. It must be replaced with a sourced argument.",
        "",
      ].join("\n"),
    },
  };
}

function fixtureTemplateSha256(input: {
  experimentId: string;
  targetMissionId: string;
  sourcePhaseId: string;
}): string {
  return hashText(canonicalJson(fixtureTemplateFor(input)));
}

export function renderWorkflowExperimentFixture(
  proposal: Pick<
    WorkflowExperimentProposal,
    "experimentId" | "targetMissionId" | "sourcePhaseId"
  >,
  missionId: string,
): { fixtureVersion: 1 | 2; files: Record<string, string>; renderedFilesSha256: string } {
  assertSafeId(missionId, "fixture missionId");
  const template = fixtureTemplateFor(proposal);
  const files = Object.fromEntries(
    Object.entries(template.files).map(([name, content]) => [
      name,
      content.replaceAll(FIXTURE_MISSION_TOKEN, missionId),
    ]),
  );
  return {
    fixtureVersion: template.fixtureVersion,
    files,
    renderedFilesSha256: hashText(canonicalJson(files)),
  };
}

export function workflowExperimentSampleMissionId(
  proposal: Pick<WorkflowExperimentProposal, "experimentMissionId">,
  arm: WorkflowExperimentArm,
  episode: number,
): string {
  if (arm !== "baseline" && arm !== "candidate") throw new Error("Experiment arm is invalid");
  if (!Number.isSafeInteger(episode) || episode < 1 || episode > MAX_EPISODES) {
    throw new Error("Experiment episode is invalid");
  }
  const missionId = `${proposal.experimentMissionId}-${arm === "baseline" ? "b" : "c"}${episode}`;
  assertSafeId(missionId, "experiment sample missionId");
  return missionId;
}

function proposalIdentity(proposal: WorkflowExperimentProposal): string {
  return JSON.stringify({
    experimentId: proposal.experimentId,
    targetMissionId: proposal.targetMissionId,
    experimentMissionId: proposal.experimentMissionId,
    sourcePhaseId: proposal.sourcePhaseId,
    baselineWorkflowId: proposal.baselineWorkflowId,
    baselineWorkflowSha256: proposal.baselineWorkflowSha256,
    candidateWorkflowId: proposal.candidateWorkflowId,
    candidateWorkflowSha256: proposal.candidateWorkflowSha256,
    promptSha256ByTemplate: proposal.promptSha256ByTemplate,
    fixtureSha256: proposal.fixtureSha256,
    requiredEpisodes: proposal.requiredEpisodes,
  });
}

export function proposeWorkflowExperiment(
  workbench: string,
  input: ProposeWorkflowExperimentInput,
): WorkflowExperimentProposal {
  assertSafeId(input.targetMissionId, "targetMissionId");
  const sourcePhaseId = input.sourcePhaseId ?? "workflow-canary";
  assertSafeId(sourcePhaseId, "sourcePhaseId");
  const requiredEpisodes = input.requiredEpisodes ?? MIN_EPISODES;
  if (!Number.isSafeInteger(requiredEpisodes) || requiredEpisodes < MIN_EPISODES || requiredEpisodes > MAX_EPISODES) {
    throw new Error(`requiredEpisodes must be between ${MIN_EPISODES} and ${MAX_EPISODES}`);
  }
  if (input.baselineWorkflowId === input.candidateWorkflowId) {
    throw new Error("Baseline and candidate workflows must differ");
  }
  const baseline = loadWorkflow(input.baselineWorkflowId);
  const candidate = loadWorkflow(input.candidateWorkflowId);
  if (baseline.evalProfile !== candidate.evalProfile) {
    throw new Error(
      `Workflow experiments require matching eval profiles: ${baseline.evalProfile} != ${candidate.evalProfile}`,
    );
  }
  const requiredEvalProfile = KNOWN_MISSION_EVAL_PROFILES.get(input.targetMissionId);
  if (requiredEvalProfile && baseline.evalProfile !== requiredEvalProfile) {
    throw new Error(
      `Workflow experiment target ${input.targetMissionId} requires eval profile ${requiredEvalProfile}`,
    );
  }
  if (baseline.slots.at(-1)?.kind !== "verify" || candidate.slots.at(-1)?.kind !== "verify") {
    throw new Error("Workflow experiments require baseline and candidate to end in verify");
  }
  const baselineWorkflowSha256 = workflowDefinitionSha256(baseline);
  const candidateWorkflowSha256 = workflowDefinitionSha256(candidate);
  const promptSha256ByTemplate = promptSha256MapFor(
    workbench,
    input.targetMissionId,
    [baseline, candidate],
  );
  const derivedId = `wfexp-${hashText([
    input.targetMissionId,
    sourcePhaseId,
    input.baselineWorkflowId,
    baselineWorkflowSha256,
    input.candidateWorkflowId,
    candidateWorkflowSha256,
    canonicalJson(promptSha256ByTemplate),
    requiredEpisodes,
  ].join("\n")).slice(0, 20)}`;
  const experimentId = input.experimentId ?? derivedId;
  assertSafeId(experimentId, "experimentId");
  const experimentMissionId = `juno-workflow-canary-${hashText(experimentId).slice(0, 16)}`;
  const fixtureSha256 = fixtureTemplateSha256({
    experimentId,
    targetMissionId: input.targetMissionId,
    sourcePhaseId,
  });
  resolveMissionDirectory(workbench, input.targetMissionId);
  resolveMissionDirectory(workbench, experimentMissionId);
  ensureExperimentRootDirectory(workbench);
  const proposalPath = workflowExperimentPaths(workbench, experimentId).proposal;
  const requestedIdentity = JSON.stringify({
    experimentId,
    targetMissionId: input.targetMissionId,
    experimentMissionId,
    sourcePhaseId,
    baselineWorkflowId: input.baselineWorkflowId,
    baselineWorkflowSha256,
    candidateWorkflowId: input.candidateWorkflowId,
    candidateWorkflowSha256,
    promptSha256ByTemplate,
    fixtureSha256,
    requiredEpisodes,
  });
  return withSelectionLease(workbench, () => {
    const previousSelection = readPreviousSelection(
      workbench,
      input.targetMissionId,
      input.baselineWorkflowId,
    );
    if (existsSync(proposalPath)) {
      const existing = readProposal(workbench, experimentId).proposal;
      if (proposalIdentity(existing) !== requestedIdentity) {
        throw new Error("Workflow experiment id already exists with a conflicting proposal");
      }
      if (!samePreviousSelection(previousSelection, existing.previousSelection)) {
        throw new WorkflowSelectionPreimageError(
          "Workflow selection changed since experiment proposal; refusing stale proposal reuse",
        );
      }
      return existing;
    }
    const proposal: WorkflowExperimentProposal = {
      experimentVersion: WORKFLOW_EXPERIMENT_VERSION,
      experimentId,
      targetMissionId: input.targetMissionId,
      experimentMissionId,
      sourcePhaseId,
      baselineWorkflowId: input.baselineWorkflowId,
      baselineWorkflowSha256,
      candidateWorkflowId: input.candidateWorkflowId,
      candidateWorkflowSha256,
      promptSha256ByTemplate,
      fixtureSha256,
      requiredEpisodes,
      previousSelection,
      createdAt: new Date().toISOString(),
    };
    createOnceJson(
      proposalPath,
      proposal,
      "Workflow experiment proposal",
      MAX_CONTROL_RECORD_BYTES,
    );
    return readProposal(workbench, experimentId).proposal;
  });
}

function literatureCanaryPrompt(runKind: RunKind | undefined): string {
  if (runKind === "verify") return LITERATURE_CANARY_PROMPTS.verify;
  if (runKind === "review" || runKind === "debate" || runKind === "vote") {
    return LITERATURE_CANARY_PROMPTS.review;
  }
  return LITERATURE_CANARY_PROMPTS.implement;
}

export function compileWorkflowExperimentArmEpisode(
  proposal: WorkflowExperimentProposal,
  arm: WorkflowExperimentArm,
  episode: number,
): QueueItem[] {
  const workflowId = arm === "baseline" ? proposal.baselineWorkflowId : proposal.candidateWorkflowId;
  const workflow = loadWorkflow(workflowId);
  let promptSha256ByTemplate = proposal.promptSha256ByTemplate;
  if (proposal.targetMissionId === AXIOM_BOOK_MISSION_ID) {
    const canaryHash = proposal.promptSha256ByTemplate[LITERATURE_CANARY_PROMPTS.implement];
    assertSha(canaryHash, "literature canary prompt SHA-256");
    promptSha256ByTemplate = Object.fromEntries(
      workflow.slots.map((slot) => [slot.prompt, canaryHash]),
    );
  }
  const items = compileWorkflowSlots({
    experimentId: proposal.experimentId,
    arm,
    episode,
    missionId: workflowExperimentSampleMissionId(proposal, arm, episode),
    sourcePhaseId: proposal.sourcePhaseId,
    fixtureSha256: proposal.fixtureSha256,
    promptSha256ByTemplate,
    workflowId,
    repoTarget: "workbench",
    provider: "openai_codex",
  });
  if (proposal.targetMissionId !== AXIOM_BOOK_MISSION_ID) return items;
  return items.map((item) => ({
    ...item,
    prompt: literatureCanaryPrompt(item.run_kind),
  }));
}

function compiledItems(proposal: WorkflowExperimentProposal): QueueItem[] {
  const items: QueueItem[] = [];
  for (let episode = 1; episode <= proposal.requiredEpisodes; episode += 1) {
    for (const arm of ["baseline", "candidate"] as const) {
      items.push(...compileWorkflowExperimentArmEpisode(proposal, arm, episode));
    }
  }
  return items;
}

function writeScaffoldFile(filePath: string, content: string): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, content, { encoding: "utf8", flag: "wx" });
    return;
  }
  const existing = readControlText(
    filePath,
    "Experiment mission scaffold",
    Math.max(1, Buffer.byteLength(content, "utf8")),
  );
  if (existing === content) return;
  throw new Error(`Experiment mission scaffold conflicts with existing file: ${filePath}`);
}

function ensureExperimentPromptTemplates(workbench: string, proposal: WorkflowExperimentProposal): void {
  if (proposal.targetMissionId !== AXIOM_BOOK_MISSION_ID) return;
  const promptRoot = path.join(workbench, "prompts");
  mkdirSync(promptRoot, { recursive: true });
  const rootStat = lstatSync(promptRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Workflow experiment prompt directory must be a regular directory");
  }
  for (const [template, content] of Object.entries(LITERATURE_CANARY_PROMPT_TEXT)) {
    const target = path.join(promptRoot, `${template}.md`);
    if (!existsSync(target)) {
      writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
    }
    const snapshot = readPromptTemplateSnapshot(workbench, template);
    if (snapshot.text !== content || snapshot.sha256 !== hashText(content)) {
      throw new Error(`Workflow experiment prompt template conflicts: ${target}`);
    }
  }
}

function fixtureReceiptPath(
  workbench: string,
  proposal: WorkflowExperimentProposal,
  arm: WorkflowExperimentArm,
  episode: number,
): string {
  return path.join(
    experimentRoot(workbench),
    `${experimentKey(proposal.experimentId)}.${arm}.${episode}.fixture.json`,
  );
}

function ensureExperimentMissionScaffold(
  workbench: string,
  proposal: WorkflowExperimentProposal,
  arm: WorkflowExperimentArm,
  episode: number,
): void {
  const missionId = workflowExperimentSampleMissionId(proposal, arm, episode);
  const missionsRoot = ensureWorkbenchRootDirectory(workbench, "missions");
  const missionPath = path.join(missionsRoot, missionId);
  if (!existsSync(missionPath)) mkdirSync(missionPath);
  const missionDir = validateMissionDirectory(workbench, missionId);
  const rendered = renderWorkflowExperimentFixture(proposal, missionId);
  const files = rendered.files;
  const receipt = {
    fixtureVersion: rendered.fixtureVersion,
    experimentId: proposal.experimentId,
    arm,
    episode,
    missionId,
    fixtureSha256: proposal.fixtureSha256,
    renderedFilesSha256: rendered.renderedFilesSha256,
  };
  const receiptPath = fixtureReceiptPath(workbench, proposal, arm, episode);
  const existingReceipt = readFileSnapshot(
    receiptPath,
    "Workflow experiment fixture receipt",
    MAX_CONTROL_RECORD_BYTES,
  );
  if (existingReceipt) {
    if (existingReceipt.raw !== canonicalJson(receipt)) {
      throw new Error(`Workflow experiment fixture receipt conflicts: ${receiptPath}`);
    }
    return;
  }
  const allowedEntries = new Set(Object.keys(files));
  for (const entry of readdirSync(missionDir)) {
    if (!allowedEntries.has(entry)) {
      throw new Error(`Experiment sample mission is not pristine: ${missionDir}`);
    }
  }
  for (const [name, content] of Object.entries(files)) {
    writeScaffoldFile(path.join(missionDir, name), content);
  }
  createOnceJson(
    receiptPath,
    receipt,
    "Workflow experiment fixture receipt",
    MAX_CONTROL_RECORD_BYTES,
  );
}

function ensureExperimentMissionScaffolds(
  workbench: string,
  proposal: WorkflowExperimentProposal,
): void {
  for (let episode = 1; episode <= proposal.requiredEpisodes; episode += 1) {
    for (const arm of ["baseline", "candidate"] as const) {
      ensureExperimentMissionScaffold(workbench, proposal, arm, episode);
    }
  }
}

function ensureRunningRecord(workbench: string, experimentId: string, proposalSha256: string): WorkflowExperimentRunningRecord {
  const existing = readRunning(workbench, experimentId, proposalSha256);
  if (existing) return existing;
  const record: WorkflowExperimentRunningRecord = {
    recordVersion: 1,
    experimentId,
    proposalSha256,
    startedAt: new Date().toISOString(),
  };
  ensureExperimentRootDirectory(workbench);
  const target = workflowExperimentPaths(workbench, experimentId).running;
  try {
    writeFileSync(target, canonicalJson(record), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readRunning(workbench, experimentId, proposalSha256)!;
}

export function queueWorkflowExperiment(
  workbench: string,
  experimentId: string,
): { queued: number; location: "now" | "backlog" | "already_queued"; revision: string | null } {
  return withSelectionLease(workbench, () => {
    const { proposal, sha256: proposalSha256 } = readProposal(workbench, experimentId);
    assertProposalPreviousSelectionCurrentLocked(workbench, proposal);
    assertCurrentWorkflowHashes(workbench, proposal);
    if (readDecision(workbench, proposal, proposalSha256)) {
      throw new Error("Terminal workflow experiment cannot be queued again");
    }
    ensureExperimentPromptTemplates(workbench, proposal);
    ensureExperimentMissionScaffolds(workbench, proposal);
    ensureRunningRecord(workbench, experimentId, proposalSha256);

    const desired = compiledItems(proposal);
    const desiredById = new Map(desired.map((item) => [item.id, item]));
    const snapshot = readNowQueueSnapshot(workbench);
    const existingQueue = new Map([...snapshot.now, ...snapshot.backlog].map((item) => [item.id, item]));
    for (const [id, item] of existingQueue) {
      const expected = desiredById.get(id);
      if (expected && queueItemFingerprint(item) !== queueItemFingerprint(expected)) {
        throw new Error(`Experiment queue id conflicts with different item: ${id}`);
      }
    }
    const missing = desired.filter((item) => {
      if (existingQueue.has(item.id)) return false;
      return !existsSync(resolveRunDirectory(workbench, item.id));
    });
    const desiredIds = new Set(desired.map((item) => item.id));
    const activateNow = snapshot.now.length === 0;
    const queuedExperimentBacklog = snapshot.backlog.filter((item) => desiredIds.has(item.id));
    if (missing.length === 0 && (!activateNow || queuedExperimentBacklog.length === 0)) {
      return { queued: 0, location: "already_queued", revision: snapshot.revision };
    }
    const activeExperimentItems = activateNow
      ? desired.filter((item) =>
          !existsSync(resolveRunDirectory(workbench, item.id)) &&
          (existingQueue.has(item.id) || missing.some((candidate) => candidate.id === item.id)),
        )
      : [];
    const update = replaceQueueSnapshotConditional(workbench, {
      expectedRevision: snapshot.revision,
      now: activateNow ? activeExperimentItems : snapshot.now,
      backlog: activateNow
        ? snapshot.backlog.filter((item) => !desiredIds.has(item.id))
        : [...snapshot.backlog, ...missing],
    });
    if (!update.ok) throw new Error(`Workflow experiment queue CAS failed: ${update.reason}`);
    return {
      queued: missing.length,
      location: activateNow ? "now" : "backlog",
      revision: update.current.revision,
    };
  });
}

const VERIFY_STEP_KEYS = [
  "command",
  "durationMs",
  "exitCode",
  "label",
  "ok",
  "optional",
  "stepId",
  "stderr",
  "stdout",
  "terminationConfirmed",
] as const;

function stableControlValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableControlValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableControlValue(entry)]),
  );
}

function sameControlValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableControlValue(left)) === JSON.stringify(stableControlValue(right));
}

function readRunEvidenceText(filePath: string, label: string): string {
  try {
    return readControlText(filePath, label, MAX_RUN_EVIDENCE_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} is missing: ${filePath}`);
    }
    throw error;
  }
}

function parseRunEvidenceJson(filePath: string, label: string): {
  value: Record<string, unknown>;
  text: string;
} {
  const text = readRunEvidenceText(filePath, label);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is unreadable`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return { value, text };
}

function readBoundQueueItem(runDir: string, expected: QueueItem): string {
  const { value, text } = parseRunEvidenceJson(
    path.join(runDir, "queue-item.json"),
    `Experiment queue item ${expected.id}`,
  );
  const { materializedAt, ...queueItem } = value;
  assertIso(materializedAt, `Experiment queue item ${expected.id} materializedAt`);
  if (queueItemFingerprint(queueItem as unknown as QueueItem) !== queueItemFingerprint(expected)) {
    throw new Error(`Experiment queue item binding is invalid: ${expected.id}`);
  }
  return hashText(text);
}

function parseExecutionEvents(text: string, runId: string): Record<string, unknown>[] {
  const events = text.split("\n").filter(Boolean).map((line, index) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`Experiment run events are unreadable: ${runId}[${index}]`, {
        cause: error,
      });
    }
    if (!isRecord(event)) throw new Error(`Experiment run event is invalid: ${runId}[${index}]`);
    assertIso(event.ts, `Experiment run event ${runId}[${index}].ts`);
    if (typeof event.type !== "string") {
      throw new Error(`Experiment run event type is invalid: ${runId}[${index}]`);
    }
    return event;
  });
  if (events.length === 0) throw new Error(`Experiment run events are empty: ${runId}`);
  return events;
}

function lastExecutionEventIndex(
  events: Record<string, unknown>[],
  predicate: (event: Record<string, unknown>) => boolean,
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index]!)) return index;
  }
  return -1;
}

function assertArtifactHashes(
  artifact: Record<string, unknown>,
  runId: string,
  manifestText: string,
  checkpoint: string | null,
  eventsText: string,
): void {
  if (
    artifact.version !== EXECUTION_ARTIFACT_VERSION ||
    artifact.runId !== runId ||
    artifact.manifestSha256 !== hashText(manifestText) ||
    artifact.checkpointSha256 !== (checkpoint === null ? null : hashText(checkpoint)) ||
    artifact.eventsSha256 !== hashText(eventsText)
  ) {
    throw new Error(`Experiment execution artifact binding is invalid: ${runId}`);
  }
}

function assertExecutionAttemptBinding(
  value: Record<string, unknown>,
  expected: ExecutionAttemptBinding,
  label: string,
): void {
  if (
    value.attemptId !== expected.attemptId ||
    value.slotIndex !== expected.slotIndex ||
    value.retryCount !== expected.retryCount
  ) {
    throw new Error(`${label} attempt binding is invalid`);
  }
}

function executionSegment(
  events: Record<string, unknown>[],
  status: "starting" | "verify_starting",
  expectedAttempt: ExecutionAttemptBinding,
  runId: string,
): Record<string, unknown>[] {
  const started = lastExecutionEventIndex(
    events,
    (event) => event.type === "status" && event.status === status,
  );
  const segment = started >= 0 ? events.slice(started) : [];
  if (segment.length === 0) {
    throw new Error(`Experiment execution attempt is missing: ${runId}`);
  }
  assertExecutionAttemptBinding(
    segment[0]!,
    expectedAttempt,
    `Experiment run event ${runId}`,
  );
  return segment;
}

function validateCodexExecutionArtifact(
  artifact: Record<string, unknown>,
  events: Record<string, unknown>[],
  runId: string,
  expectedAttempt: ExecutionAttemptBinding,
): boolean {
  if (
    typeof artifact.ok !== "boolean" ||
    (artifact.threadId !== null && (typeof artifact.threadId !== "string" || !artifact.threadId)) ||
    typeof artifact.model !== "string" ||
    !artifact.model ||
    (artifact.ok
      ? artifact.failure !== undefined || !isRecord(artifact.usage) || typeof artifact.threadId !== "string"
      : typeof artifact.failure !== "string" || !artifact.failure)
  ) {
    throw new Error(`Experiment Codex artifact completion is invalid: ${runId}`);
  }
  assertIso(artifact.completedAt, `Experiment Codex artifact ${runId}.completedAt`);
  if (isRecord(artifact.usage)) {
    for (const key of [
      "input_tokens",
      "cached_input_tokens",
      "output_tokens",
      "reasoning_output_tokens",
    ]) {
      const count = artifact.usage[key];
      if (!Number.isSafeInteger(count) || (count as number) < 0) {
        throw new Error(`Experiment Codex usage is invalid: ${runId}.${key}`);
      }
    }
  } else if (artifact.usage !== null) {
    throw new Error(`Experiment Codex usage is invalid: ${runId}`);
  }
  const segment = executionSegment(events, "starting", expectedAttempt, runId);
  const finished = segment.at(-1);
  if (
    finished?.type !== "finished" ||
    finished.status !== (artifact.ok ? "finished" : "error") ||
    (artifact.ok &&
      (!segment.some(
        (event) =>
          event.type === "status" &&
          event.status === "codex_thread_started" &&
          event.detail === artifact.threadId,
      ) ||
        !segment.some(
          (event) => event.type === "assistant" && typeof event.text === "string" && event.text.trim(),
        ))) ||
    (!artifact.ok && !segment.some((event) => event.type === "error"))
  ) {
    throw new Error(`Experiment Codex events do not prove completion: ${runId}`);
  }
  return artifact.ok;
}

function expectedVerifyProfileSteps(expected: QueueItem): VerifyStep[] {
  const profile = normalizeEvalProfile(expected.eval_profile);
  if (profile === "literature" || (expected.repo_target ?? "workbench") === "juno-overseer") {
    return verifyStepsForProfile(profile);
  }
  return [];
}

function validateVerifyStepShape(
  rawStep: unknown,
  runId: string,
  index: number,
): Record<string, unknown> {
  if (!isRecord(rawStep)) throw new Error(`Experiment verify step is invalid: ${runId}[${index}]`);
  assertExactKeys(rawStep, VERIFY_STEP_KEYS, `Experiment verify step ${runId}[${index}]`);
  if (
    typeof rawStep.stepId !== "string" ||
    !SHA256.test(rawStep.stepId) ||
    typeof rawStep.label !== "string" ||
    !rawStep.label ||
    typeof rawStep.command !== "string" ||
    !rawStep.command ||
    !Number.isSafeInteger(rawStep.exitCode) ||
    !Number.isSafeInteger(rawStep.durationMs) ||
    (rawStep.durationMs as number) < 0 ||
    typeof rawStep.optional !== "boolean" ||
    typeof rawStep.ok !== "boolean" ||
    typeof rawStep.terminationConfirmed !== "boolean" ||
    typeof rawStep.stdout !== "string" ||
    typeof rawStep.stderr !== "string" ||
    (rawStep.ok && (rawStep.exitCode !== 0 || !rawStep.terminationConfirmed))
  ) {
    throw new Error(`Experiment verify step evidence is invalid: ${runId}[${index}]`);
  }
  return rawStep;
}

function assertOrchestratorVerifySteps(
  steps: Record<string, unknown>[],
  expected: QueueItem,
  realSteps: Record<string, unknown>[],
): boolean {
  for (const [index, step] of steps.entries()) {
    if (
      step.command !== "orchestrator:safety-verify" &&
      step.command !== "orchestrator:artifact-check"
    ) {
      throw new Error(`Experiment verify orchestrator step is invalid: ${expected.id}[${index}]`);
    }
    const expectedStepId = hashText(JSON.stringify({
      command: step.command,
      label: step.label,
    }));
    if (step.stepId !== expectedStepId) {
      throw new Error(`Experiment verify orchestrator step binding is invalid: ${expected.id}[${index}]`);
    }
  }

  let offset = 0;
  let safetyFailed = false;
  if (expected.mission_id) {
    const safety = steps[0];
    if (
      safety?.command !== "orchestrator:safety-verify" ||
      safety.label !== "mission safety preflight"
    ) {
      throw new Error(`Experiment verify safety preflight is missing: ${expected.id}`);
    }
    safetyFailed = safety.ok === false;
    offset = 1;
  } else if (steps[0]?.command === "orchestrator:safety-verify") {
    throw new Error(`Experiment verify safety preflight is unexpected: ${expected.id}`);
  }

  const checks = steps.slice(offset);
  if (safetyFailed) {
    if (checks.length > 0 || realSteps.length > 0) {
      throw new Error(`Experiment verify continued after failed safety preflight: ${expected.id}`);
    }
    return true;
  }

  const profile = normalizeEvalProfile(expected.eval_profile);
  const workbenchTarget = (expected.repo_target ?? "workbench") === "workbench";
  if (profile === "literature") {
    if (checks.length < 1 || checks.some((step) => step.command !== "orchestrator:artifact-check")) {
      throw new Error(`Experiment literature artifact checks are missing: ${expected.id}`);
    }
  } else if (workbenchTarget) {
    if (
      checks.length !== 1 ||
      checks[0]?.command !== "orchestrator:artifact-check" ||
      checks[0]?.label !== "Workbench package execution has an OS sandbox" ||
      checks[0]?.ok !== false
    ) {
      throw new Error(`Experiment Workbench sandbox refusal is invalid: ${expected.id}`);
    }
  } else if (checks.length > 0) {
    throw new Error(`Experiment verify artifact checks are unexpected: ${expected.id}`);
  }
  return false;
}

function verifyToolCommand(event: Record<string, unknown>): string {
  if (typeof event.tool !== "string" || !event.tool || typeof event.args !== "string") {
    return "";
  }
  return event.args ? `${event.tool} ${event.args}` : event.tool;
}

function validateVerifyExecutionArtifact(
  artifact: Record<string, unknown>,
  events: Record<string, unknown>[],
  expected: QueueItem,
  expectedAttempt: ExecutionAttemptBinding,
): boolean {
  const terminalFailure =
    typeof artifact.failure === "string" && artifact.failure.trim().length > 0;
  if (
    typeof artifact.ok !== "boolean" ||
    artifact.profile !== normalizeEvalProfile(expected.eval_profile) ||
    typeof artifact.cwd !== "string" ||
    !artifact.cwd ||
    artifact.terminationConfirmed !== true ||
    !Array.isArray(artifact.steps) ||
    artifact.steps.length > 64 ||
    (terminalFailure
      ? artifact.ok || artifact.steps.length !== 0
      : artifact.failure !== undefined || artifact.steps.length < 1)
  ) {
    throw new Error(`Experiment verify artifact is invalid: ${expected.id}`);
  }
  assertIso(artifact.verifiedAt, `Experiment verify artifact ${expected.id}.verifiedAt`);
  const steps = artifact.steps.map((step, index) =>
    validateVerifyStepShape(step, expected.id, index));
  const firstRealStep = steps.findIndex((step) =>
    typeof step.command === "string" && !step.command.startsWith("orchestrator:"));
  const splitAt = firstRealStep < 0 ? steps.length : firstRealStep;
  const orchestratorSteps = steps.slice(0, splitAt);
  const realSteps = steps.slice(splitAt);
  if (realSteps.some((step) =>
    typeof step.command !== "string" || step.command.startsWith("orchestrator:"))) {
    throw new Error(`Experiment verify step ordering is invalid: ${expected.id}`);
  }

  let safetyFailed = false;
  if (!terminalFailure) {
    safetyFailed = assertOrchestratorVerifySteps(orchestratorSteps, expected, realSteps);
    const expectedSteps = expectedVerifyProfileSteps(expected);
    if ((!safetyFailed && realSteps.length !== expectedSteps.length) || realSteps.length > expectedSteps.length) {
      throw new Error(`Experiment verify profile step count is invalid: ${expected.id}`);
    }
    for (const [index, rawStep] of realSteps.entries()) {
      const expectedStep = expectedSteps[index]!;
      const expectedInvocation = verifyStepInvocationEvidence(expectedStep);
      if (
        rawStep.stepId !== verifyStepId(expectedStep) ||
        rawStep.label !== expectedStep.label ||
        rawStep.optional !== (expectedStep.optional === true) ||
        rawStep.command !== expectedInvocation.command
      ) {
        throw new Error(`Experiment verify profile step binding is invalid: ${expected.id}[${index}]`);
      }
    }
    const recomputedOk = steps.every((step) => step.optional === true || step.ok === true);
    if (artifact.ok !== recomputedOk) {
      throw new Error(`Experiment verify result is not backed by step evidence: ${expected.id}`);
    }
  }

  const segment = executionSegment(events, "verify_starting", expectedAttempt, expected.id);
  const finished = segment.at(-1);
  const toolCalls = segment.filter((event) => event.type === "tool_call");
  if (
    finished?.type !== "finished" ||
    finished.status !== (artifact.ok ? "finished" : "error") ||
    finished.model !== "deterministic" ||
    (terminalFailure && !segment.some((event) => event.type === "error")) ||
    toolCalls.length !== realSteps.length * 2
  ) {
    throw new Error(`Experiment verify events do not prove execution: ${expected.id}`);
  }
  for (const [index, step] of realSteps.entries()) {
    const expectedStep = expectedVerifyProfileSteps(expected)[index]!;
    const expectedInvocation = verifyStepInvocationEvidence(expectedStep);
    const started = toolCalls[index * 2]!;
    const completed = toolCalls[index * 2 + 1]!;
    assertExecutionAttemptBinding(
      started,
      expectedAttempt,
      `Experiment verify tool start ${expected.id}[${index}]`,
    );
    assertExecutionAttemptBinding(
      completed,
      expectedAttempt,
      `Experiment verify tool completion ${expected.id}[${index}]`,
    );
    if (
      started.phase !== "started" ||
      started.ok !== undefined ||
      completed.phase !== "completed" ||
      completed.ok !== step.ok ||
      started.stepId !== step.stepId ||
      completed.stepId !== step.stepId ||
      started.tool !== completed.tool ||
      started.args !== completed.args ||
      started.tool !== expectedInvocation.tool ||
      started.args !== expectedInvocation.args ||
      verifyToolCommand(started) !== step.command
    ) {
      throw new Error(`Experiment verify tool event binding is invalid: ${expected.id}[${index}]`);
    }
  }
  return artifact.ok;
}

function validateExecutionProvenance(
  runDir: string,
  expected: QueueItem,
  manifestText: string,
  checkpoint: string | null,
  state: Pick<RunState, "slotIndex" | "retryCount">,
): { executionArtifactSha256: string; eventsSha256: string; executionOk: boolean } {
  const eventsText = readRunEvidenceText(
    path.join(runDir, "events.jsonl"),
    `Experiment run events ${expected.id}`,
  );
  const events = parseExecutionEvents(eventsText, expected.id);
  const artifactName = expected.run_kind === "verify"
    ? "verify-artifact.json"
    : "codex-artifact.json";
  const { value: artifact, text: artifactText } = parseRunEvidenceJson(
    path.join(runDir, artifactName),
    `Experiment execution artifact ${expected.id}`,
  );
  const expectedAttempt = executionAttemptBinding(expected.id, state.slotIndex, state.retryCount);
  assertArtifactHashes(artifact, expected.id, manifestText, checkpoint, eventsText);
  assertExecutionAttemptBinding(
    artifact,
    expectedAttempt,
    `Experiment execution artifact ${expected.id}`,
  );
  let executionOk = true;
  if (expected.run_kind === "verify") {
    executionOk = validateVerifyExecutionArtifact(artifact, events, expected, expectedAttempt);
  } else {
    executionOk = validateCodexExecutionArtifact(artifact, events, expected.id, expectedAttempt);
  }
  return {
    executionArtifactSha256: hashText(artifactText),
    eventsSha256: hashText(eventsText),
    executionOk,
  };
}

function expectedRevisionItem(
  workbench: string,
  proposal: WorkflowExperimentProposal,
  runId: string,
  manifest: {
    revisionOf?: unknown;
    revisionAttempt?: unknown;
  },
  expectedById: Map<string, QueueItem>,
): QueueItem | null {
  if (manifest.revisionOf === undefined && manifest.revisionAttempt === undefined) return null;
  if (typeof manifest.revisionOf !== "string" || !Number.isSafeInteger(manifest.revisionAttempt)) {
    throw new Error(`Experiment revision lineage is incomplete: ${runId}`);
  }
  const attempt = manifest.revisionAttempt as number;
  if (runId !== revisionFixRunId(manifest.revisionOf, attempt)) {
    throw new Error(`Experiment revision run id is invalid: ${runId}`);
  }
  const parent = expectedById.get(manifest.revisionOf);
  if (!parent || !(["review", "debate", "vote"] as unknown[]).includes(parent.run_kind)) {
    throw new Error(`Experiment revision parent is not a compiled review slot: ${runId}`);
  }
  const parentDir = resolveRunDirectory(workbench, parent.id);
  const parentManifestPath = path.join(parentDir, "manifest.json");
  const parentCheckpointPath = path.join(parentDir, "checkpoint.md");
  let parentManifest: unknown;
  try {
    parentManifest = JSON.parse(readControlText(
      parentManifestPath,
      "Experiment revision parent manifest",
      MAX_CONTROL_RECORD_BYTES,
    ));
  } catch (error) {
    throw new Error(`Experiment revision parent manifest is unreadable: ${parent.id}`, { cause: error });
  }
  if (
    !isRecord(parentManifest) ||
    parentManifest.runId !== parent.id ||
    parentManifest.missionId !== parent.mission_id ||
    parentManifest.phaseId !== parent.phase_id ||
    parentManifest.runKind !== parent.run_kind ||
    parentManifest.workflowId !== parent.workflow_id ||
    parentManifest.evalProfile !== parent.eval_profile ||
    parentManifest.experimentId !== proposal.experimentId ||
    parentManifest.experimentArm !== parent.experiment_arm ||
    parentManifest.experimentEpisode !== parent.experiment_episode ||
    parentManifest.sourcePhaseId !== proposal.sourcePhaseId ||
    parentManifest.experimentFixtureSha256 !== proposal.fixtureSha256 ||
    parentManifest.experimentPromptSha256 !== parent.experiment_prompt_sha256
  ) {
    throw new Error(`Experiment revision parent manifest binding is invalid: ${parent.id}`);
  }
  const parentCheckpoint = readControlText(
    parentCheckpointPath,
    "Experiment revision parent checkpoint",
    MAX_RUN_EVIDENCE_BYTES,
  );
  const verdict = parseReviewVerdict(parentCheckpoint);
  if (verdict?.verdict !== "REVISE") {
    throw new Error(`Experiment revision parent did not request REVISE: ${parent.id}`);
  }
  const expected = buildReviseImplementItem(
    parent,
    attempt,
    verdict.mustFixNextSlot,
    revisionPromptBinding(proposal),
  );
  const queueItemPath = path.join(resolveRunDirectory(workbench, runId), "queue-item.json");
  let materialized: unknown;
  try {
    materialized = JSON.parse(readControlText(
      queueItemPath,
      "Experiment revision queue item",
      MAX_CONTROL_RECORD_BYTES,
    ));
  } catch (error) {
    throw new Error(`Experiment revision queue item is unreadable: ${runId}`, { cause: error });
  }
  if (!isRecord(materialized)) throw new Error(`Experiment revision queue item is invalid: ${runId}`);
  const { materializedAt, ...queueItem } = materialized;
  assertIso(materializedAt, `Experiment revision ${runId} materializedAt`);
  if (queueItemFingerprint(queueItem as unknown as QueueItem) !== queueItemFingerprint(expected)) {
    throw new Error(`Experiment revision queue item binding is invalid: ${runId}`);
  }
  return expected;
}

function readRunEvidence(workbench: string, proposal: WorkflowExperimentProposal): RunEvidence[] {
  const runsDir = path.join(workbench, "runs");
  if (!existsSync(runsDir)) return [];
  const expectedById = new Map(compiledItems(proposal).map((item) => [item.id, item]));
  const evidence: RunEvidence[] = [];
  for (const name of readdirSync(runsDir)) {
    const runDir = resolveRunDirectory(workbench, name);
    const manifestPath = path.join(runDir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    let manifestText: string;
    let manifest: Record<string, unknown>;
    try {
      const location = validateRunManifestPath(workbench, manifestPath);
      if (location.runDir !== path.resolve(runDir) || location.runId !== name) {
        throw new Error(`Experiment run directory binding is invalid: ${name}`);
      }
      manifestText = readRunEvidenceText(manifestPath, "Experiment run manifest");
      const parsed = JSON.parse(manifestText) as unknown;
      if (!isRecord(parsed)) throw new Error("manifest must be a JSON object");
      manifest = parsed;
    } catch {
      continue;
    }
    if (manifest.experimentId !== proposal.experimentId) continue;
    const expected = expectedById.get(name) ?? expectedRevisionItem(
      workbench,
      proposal,
      name,
      manifest,
      expectedById,
    );
    if (!expected) throw new Error(`Unexpected run claims workflow experiment binding: ${name}`);
    if (!sameControlValue(manifest, buildManifestFromQueue(expected, workbench))) {
      throw new Error(`Experiment run manifest binding is invalid: ${name}`);
    }
    const queueItemSha256 = readBoundQueueItem(runDir, expected);
    const arm = manifest.experimentArm as WorkflowExperimentArm;
    const checkpointPath = path.join(runDir, "checkpoint.md");
    const checkpointEvidence = existsSync(checkpointPath)
      ? readRunEvidenceText(checkpointPath, "Experiment run checkpoint")
      : null;
    const checkpoint = checkpointEvidence ?? "";
    const safetyPath = path.join(runDir, "safety-verify.md");
    const safety = existsSync(safetyPath)
      ? readRunEvidenceText(safetyPath, "Experiment run safety report")
      : "";
    let lastStatus = "";
    let retryCount = 0;
    const statePath = path.join(runDir, "run-state.json");
    if (!existsSync(statePath)) throw new Error(`Experiment run state is missing: ${name}`);
    const { value: state } = parseRunEvidenceJson(statePath, "Experiment run state");
    if (
      !Number.isSafeInteger(state.retryCount) ||
      (state.retryCount as number) < 0 ||
      (state.retryCount as number) > 20 ||
      !Number.isSafeInteger(state.slotIndex) ||
      (state.slotIndex as number) < 0 ||
      !Number.isSafeInteger(state.maxRetries) ||
      (state.maxRetries as number) < 0 ||
      (state.maxRetries as number) > 20 ||
      (state.lastStatus !== undefined && typeof state.lastStatus !== "string")
    ) {
      throw new Error(`Experiment run state is invalid: ${name}`);
    }
    lastStatus = (state.lastStatus as string | undefined) ?? "";
    retryCount = state.retryCount as number;
    const runKind = manifest.runKind as RunKind;
    const outcome = observeRunOutcome(runKind, lastStatus, checkpoint, safety);
    let executionArtifactSha256: string | null = null;
    let eventsSha256: string | null = null;
    if (outcome.observed) {
      if ((state.slotIndex as number) < 1) {
        throw new Error(`Experiment run completion has no executed slot: ${name}`);
      }
      const provenance = validateExecutionProvenance(
        runDir,
        expected,
        manifestText,
        checkpointEvidence,
        {
          slotIndex: state.slotIndex as number,
          retryCount: state.retryCount as number,
        },
      );
      executionArtifactSha256 = provenance.executionArtifactSha256;
      eventsSha256 = provenance.eventsSha256;
      if (runKind === "verify" && provenance.executionOk !== outcome.verifyPass) {
        throw new Error(`Experiment verify artifact disagrees with checkpoint outcome: ${name}`);
      }
      if (
        runKind !== "verify" &&
        /^(?:done|finished)$/i.test(lastStatus) &&
        !provenance.executionOk
      ) {
        throw new Error(`Experiment Codex artifact disagrees with transport outcome: ${name}`);
      }
    }
    evidence.push({
      runId: name,
      missionId: manifest.missionId as string,
      arm,
      episode: manifest.experimentEpisode as number,
      runKind,
      workflowId: manifest.workflowId as string,
      promptSha256: manifest.experimentPromptSha256 as string,
      revisionOf: (manifest.revisionOf as string | undefined) ?? null,
      revisionAttempt: (manifest.revisionAttempt as number | undefined) ?? null,
      fixtureSha256: proposal.fixtureSha256,
      observed: outcome.observed,
      success: outcome.success,
      failure: outcome.failure,
      revised: outcome.revised,
      safetyBlocked: outcome.safetyBlocked,
      verifyPass: outcome.verifyPass,
      retryCount,
      queueItemSha256,
      manifestSha256: hashText(manifestText),
      checkpointSha256: checkpointEvidence === null ? null : hashText(checkpointEvidence),
      safetySha256: safety ? hashText(safety) : null,
      executionArtifactSha256,
      eventsSha256,
    });
  }
  return evidence.sort((a, b) => a.runId.localeCompare(b.runId));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function metricsForArm(
  proposal: WorkflowExperimentProposal,
  arm: WorkflowExperimentArm,
  evidence: RunEvidence[],
): WorkflowArmMetrics {
  const expectedByEpisode = new Map<number, Set<string>>();
  for (let episode = 1; episode <= proposal.requiredEpisodes; episode += 1) {
    expectedByEpisode.set(
      episode,
      new Set(compileWorkflowExperimentArmEpisode(proposal, arm, episode).map((item) => item.id)),
    );
  }
  const armEvidence = evidence.filter((run) => run.arm === arm);
  let completedEpisodes = 0;
  let verifyPasses = 0;
  for (let episode = 1; episode <= proposal.requiredEpisodes; episode += 1) {
    const runs = armEvidence.filter((run) => run.episode === episode);
    const observedIds = new Set(runs.filter((run) => run.observed).map((run) => run.runId));
    const expected = expectedByEpisode.get(episode)!;
    const complete = [...expected].every((id) => observedIds.has(id));
    if (!complete) continue;
    completedEpisodes += 1;
    if (runs.filter((run) => run.runKind === "verify").some((run) => run.verifyPass)) {
      verifyPasses += 1;
    }
  }
  const observed = armEvidence.filter((run) => run.observed);
  const failures = observed.filter((run) => run.failure).length;
  const revisions = observed.filter((run) => run.revised).length;
  const safetyBlocks = armEvidence.filter((run) => run.safetyBlocked).length;
  const retries = armEvidence.reduce((sum, run) => sum + run.retryCount, 0);
  const observedSlots = observed.length;
  return {
    completedEpisodes,
    verifyPasses,
    verifyFailures: Math.max(0, completedEpisodes - verifyPasses),
    observedSlots,
    failures,
    revisions,
    safetyBlocks,
    retries,
    verifyPassRate: completedEpisodes > 0 ? round(verifyPasses / completedEpisodes) : 0,
    failureRate: observedSlots > 0 ? round(failures / observedSlots) : 0,
    reviseRate: observedSlots > 0 ? round(revisions / observedSlots) : 0,
    averageRetries: completedEpisodes > 0 ? round(retries / completedEpisodes) : 0,
    averageSlots: completedEpisodes > 0 ? round(observedSlots / completedEpisodes) : 0,
  };
}

function collectMetrics(
  workbench: string,
  proposal: WorkflowExperimentProposal,
): { metrics: WorkflowExperimentMetrics; evidence: RunEvidence[]; evidenceSha256: string } {
  const evidence = readRunEvidence(workbench, proposal);
  return {
    metrics: {
      baseline: metricsForArm(proposal, "baseline", evidence),
      candidate: metricsForArm(proposal, "candidate", evidence),
    },
    evidence,
    evidenceSha256: hashText(JSON.stringify(evidence)),
  };
}

function compareMetrics(
  proposal: WorkflowExperimentProposal,
  metrics: WorkflowExperimentMetrics,
): { terminal: boolean; decision?: "accepted" | "rejected"; reason: string } {
  const { baseline, candidate } = metrics;
  if (candidate.safetyBlocks > 0) {
    return { terminal: true, decision: "rejected", reason: "candidate safety block observed" };
  }
  if (
    baseline.completedEpisodes < proposal.requiredEpisodes ||
    candidate.completedEpisodes < proposal.requiredEpisodes
  ) {
    return {
      terminal: false,
      reason: `insufficient episodes: baseline=${baseline.completedEpisodes}/${proposal.requiredEpisodes}, candidate=${candidate.completedEpisodes}/${proposal.requiredEpisodes}`,
    };
  }
  if (
    baseline.verifyPasses < proposal.requiredEpisodes ||
    candidate.verifyPasses < proposal.requiredEpisodes
  ) {
    return {
      terminal: true,
      decision: "rejected",
      reason: `deterministic verification gate failed: baseline=${baseline.verifyPasses}/${proposal.requiredEpisodes}, candidate=${candidate.verifyPasses}/${proposal.requiredEpisodes}`,
    };
  }
  const regressions = [
    candidate.verifyPassRate < baseline.verifyPassRate ? "verify pass rate regressed" : null,
    candidate.failureRate > baseline.failureRate ? "failure rate regressed" : null,
    candidate.reviseRate > baseline.reviseRate ? "revise rate regressed" : null,
    candidate.averageRetries > baseline.averageRetries ? "retry cost regressed" : null,
    candidate.averageSlots > baseline.averageSlots ? "slot cost regressed" : null,
  ].filter((reason): reason is string => Boolean(reason));
  if (regressions.length > 0) {
    return { terminal: true, decision: "rejected", reason: regressions.join("; ") };
  }
  const improvements = [
    candidate.verifyPassRate > baseline.verifyPassRate,
    candidate.failureRate < baseline.failureRate,
    candidate.reviseRate < baseline.reviseRate,
    candidate.averageRetries < baseline.averageRetries,
    candidate.averageSlots < baseline.averageSlots,
  ];
  if (!improvements.some(Boolean)) {
    return {
      terminal: true,
      decision: "rejected",
      reason: "candidate produced no strict improvement over baseline",
    };
  }
  return {
    terminal: true,
    decision: "accepted",
    reason: "candidate produced a strict improvement with no verify, failure, revise, retry, or slot-cost regression",
  };
}

function decisionMatchesLiveEvidence(
  receipt: WorkflowExperimentDecisionReceipt,
  live: { metrics: WorkflowExperimentMetrics; evidence: RunEvidence[]; evidenceSha256: string },
): boolean {
  return receipt.evidenceSha256 === live.evidenceSha256 &&
    JSON.stringify(receipt.evidence) === JSON.stringify(live.evidence) &&
    JSON.stringify(receipt.metrics) === JSON.stringify(live.metrics);
}

export function inspectWorkflowExperiment(workbench: string, experimentId: string): WorkflowExperimentSnapshot {
  const { proposal, sha256: proposalSha256 } = readProposal(workbench, experimentId);
  assertCurrentWorkflowHashes(workbench, proposal);
  const running = readRunning(workbench, experimentId, proposalSha256);
  const decision = readDecision(workbench, proposal, proposalSha256);
  if (decision && !running) throw new Error("Decision receipt exists without a running record");
  const metrics = decision?.metrics ?? collectMetrics(workbench, proposal).metrics;
  return {
    proposal,
    proposalSha256,
    status: decision?.decision ?? (running ? "running" : "proposed"),
    running,
    decision,
    metrics,
  };
}

function writeDecisionOnce(
  workbench: string,
  proposal: WorkflowExperimentProposal,
  proposalSha256: string,
  receipt: WorkflowExperimentDecisionReceipt,
): void {
  ensureExperimentRootDirectory(workbench);
  const target = workflowExperimentPaths(workbench, proposal.experimentId).decision;
  const text = canonicalJson(receipt);
  if (Buffer.byteLength(text, "utf8") > MAX_RUN_EVIDENCE_BYTES) {
    throw new Error(`Workflow experiment decision receipt exceeds the ${MAX_RUN_EVIDENCE_BYTES}-byte limit`);
  }
  try {
    writeFileSync(target, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readDecision(workbench, proposal, proposalSha256);
    if (
      !existing ||
      existing.decision !== receipt.decision ||
      existing.reason !== receipt.reason ||
      existing.fixtureSha256 !== receipt.fixtureSha256 ||
      existing.evidenceSha256 !== receipt.evidenceSha256 ||
      JSON.stringify(existing.evidence) !== JSON.stringify(receipt.evidence) ||
      JSON.stringify(existing.metrics) !== JSON.stringify(receipt.metrics)
    ) {
      throw new Error("Workflow experiment decision raced with conflicting evidence", {
        cause: error,
      });
    }
  }
}

export function evaluateWorkflowExperiment(
  workbench: string,
  experimentId: string,
): WorkflowExperimentSnapshot {
  const current = inspectWorkflowExperiment(workbench, experimentId);
  if (!current.running) throw new Error("Workflow experiment must be running before evaluation");
  if (current.decision) return current;
  const live = collectMetrics(workbench, current.proposal);
  const evaluation = compareMetrics(current.proposal, live.metrics);
  if (!evaluation.terminal || !evaluation.decision) return current;
  const receipt: WorkflowExperimentDecisionReceipt = {
    receiptVersion: WORKFLOW_EXPERIMENT_RECEIPT_VERSION,
    experimentId,
    proposalSha256: current.proposalSha256,
    decision: evaluation.decision,
    reason: evaluation.reason,
    metrics: live.metrics,
    evidence: live.evidence,
    evidenceSha256: live.evidenceSha256,
    fixtureSha256: current.proposal.fixtureSha256,
    decidedAt: new Date().toISOString(),
  };
  writeDecisionOnce(workbench, current.proposal, current.proposalSha256, receipt);
  return inspectWorkflowExperiment(workbench, experimentId);
}

export function workflowSelectionPath(workbench: string): string {
  return path.join(workbench, "state", "workflow-selection.json");
}

export function workflowSelectionArchivePaths(
  workbench: string,
  selectionSha256: string,
): { archive: string; receipt: string } {
  assertSha(selectionSha256, "selectionSha256");
  const root = path.join(workbench, "state", "workflow-selection-archive");
  return {
    archive: path.join(root, `${selectionSha256}.json`),
    receipt: path.join(root, `${selectionSha256}.receipt.json`),
  };
}

function previousSelectionText(previous: PreviousWorkflowSelection): string | null {
  return previous.exists ? previous.json : null;
}

function activeSelectionForExperiment(
  proposal: WorkflowExperimentProposal,
  decisionSha256: string,
): Record<string, unknown> {
  return {
    selectionVersion: 1,
    missionId: proposal.targetMissionId,
    workflowId: proposal.candidateWorkflowId,
    active: true,
    experimentId: proposal.experimentId,
    decisionReceiptSha256: decisionSha256,
    updatedAt: new Date().toISOString(),
  };
}

function assertTrustedSelectionDocument(
  workbench: string,
  value: Record<string, unknown>,
  missionId: string,
  raw?: string,
  options: { requireCurrentWorkflowHashes?: boolean } = {},
): { workflowId: string; experimentId: string; decisionReceiptSha256: string } {
  assertExactKeys(
    value,
    [
      "active",
      "decisionReceiptSha256",
      "experimentId",
      "missionId",
      "selectionVersion",
      "updatedAt",
      "workflowId",
    ],
    "Workflow selection",
  );
  if (raw !== undefined && Buffer.byteLength(raw, "utf8") > MAX_SELECTION_BYTES) {
    throw new Error("Workflow selection exceeds 64 KiB");
  }
  if (value.selectionVersion !== 1 || value.active !== true || value.missionId !== missionId) {
    throw new Error("Workflow selection version, active state, or mission binding is invalid");
  }
  assertSafeId(value.experimentId, "Workflow selection experimentId");
  if (typeof value.workflowId !== "string" || !value.workflowId) {
    throw new Error("Workflow selection workflowId is invalid");
  }
  assertSha(value.decisionReceiptSha256, "Workflow selection decisionReceiptSha256");
  assertIso(value.updatedAt, "Workflow selection updatedAt");
  const { proposal, sha256: proposalSha256 } = readProposal(workbench, value.experimentId);
  let decision: WorkflowExperimentDecisionReceipt | null;
  let decisionSha256: string;
  if (options.requireCurrentWorkflowHashes !== false) {
    assertCurrentWorkflowHashes(workbench, proposal);
    const snapshot = readCurrentDecisionSnapshot(workbench, proposal, proposalSha256);
    decision = snapshot?.decision ?? null;
    decisionSha256 = snapshot?.sha256 ?? "";
  } else {
    const snapshot = readAcceptedRollbackDecision(workbench, proposal, proposalSha256);
    decision = snapshot?.decision ?? null;
    decisionSha256 = snapshot?.sha256 ?? "";
  }
  if (!decision || decision.decision !== "accepted") {
    throw new Error("Workflow selection is not backed by an accepted decision");
  }
  if (
    decisionSha256 !== value.decisionReceiptSha256 ||
    proposal.targetMissionId !== missionId ||
    proposal.candidateWorkflowId !== value.workflowId
  ) {
    throw new Error("Workflow selection trust chain binding is invalid");
  }
  return {
    workflowId: value.workflowId,
    experimentId: value.experimentId,
    decisionReceiptSha256: value.decisionReceiptSha256,
  };
}

interface TrustedWorkflowSelectionSnapshot {
  raw: string;
  sha256: string;
  workflowId: string;
  experimentId: string;
  decisionReceiptSha256: string;
}

function readTrustedWorkflowSelectionSnapshotLocked(
  workbench: string,
  missionId: string,
  options: { requireCurrentWorkflowHashes?: boolean } = {},
): TrustedWorkflowSelectionSnapshot | null {
  assertNoWorkflowSelectionRecoveryState(workbench);
  const target = workflowSelectionPath(workbench);

  try {
    const snapshot = readSelectionSnapshot(target);
    if (!snapshot) return null;
    const raw = snapshot.raw;
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) throw new Error("Workflow selection must be a JSON object");
    if (value.missionId !== missionId) {
      throw new Error(`Workflow selection belongs to another mission: ${String(value.missionId)}`);
    }
    const trusted = assertTrustedSelectionDocument(workbench, value, missionId, raw, options);
    return {
      raw,
      sha256: snapshot.sha256,
      ...trusted,
    };
  } catch (error) {
    if (error instanceof WorkflowSelectionPreimageError) throw error;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new WorkflowSelectionPreimageError(
      `Workflow selection is present but invalid or untrusted; refusing fallback${detail}`,
      { cause: error },
    );
  }
}

interface LegacyWorkflowSelectionV0 {
  workflowId: string;
  score: number;
  reasons: string[];
  updatedAt: string;
}

interface MigrationSelectionSource {
  bytes: Buffer;
  text: string;
  sha256: string;
  snapshot: FileSnapshot;
}

const MIGRATION_RECEIPT_KEYS = [
  "archiveRelativePath",
  "archivedAt",
  "legacySchemaVersion",
  "legacyWorkflowId",
  "operatorReason",
  "receiptKind",
  "receiptVersion",
  "selectionByteLength",
  "selectionSha256",
  "sourceRelativePath",
] as const;

function pathEntryExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readMigrationSelectionSource(target: string, label: string): MigrationSelectionSource {
  const snapshot = readSelectionSnapshot(target, label);
  if (!snapshot) throw new Error(`${label} is missing`);
  const bytes = Buffer.from(snapshot.raw, "utf8");
  if (bytes.byteLength !== Number(snapshot.size)) {
    throw new Error(`${label} uses a non-canonical UTF-8 byte encoding`);
  }
  return {
    bytes,
    text: snapshot.raw,
    sha256: snapshot.sha256,
    snapshot,
  };
}

function parseLegacyWorkflowSelectionV0(value: unknown): LegacyWorkflowSelectionV0 | null {
  if (!isRecord(value)) return null;
  try {
    assertExactKeys(value, ["reasons", "score", "updatedAt", "workflowId"], "Legacy workflow selection");
    if (
      typeof value.workflowId !== "string" ||
      value.workflowId.length < 1 ||
      value.workflowId.length > 256 ||
      /[\u0000-\u001f]/.test(value.workflowId)
    ) {
      throw new Error("Legacy workflowId is invalid");
    }
    if (!Number.isFinite(value.score)) throw new Error("Legacy score is invalid");
    if (
      !Array.isArray(value.reasons) ||
      value.reasons.length > 100 ||
      !value.reasons.every((reason) => typeof reason === "string" && reason.length <= 1_000)
    ) {
      throw new Error("Legacy reasons are invalid");
    }
    assertIso(value.updatedAt, "Legacy workflow selection updatedAt");
    return value as unknown as LegacyWorkflowSelectionV0;
  } catch {
    return null;
  }
}

function classifyWorkflowSelection(
  workbench: string,
  source: MigrationSelectionSource,
): WorkflowSelectionMigrationInspection {
  const selectionPath = workflowSelectionPath(workbench);
  let value: unknown;
  try {
    value = JSON.parse(source.text);
  } catch {
    return {
      status: "unsupported",
      selectionPath,
      sha256: source.sha256,
      byteLength: source.bytes.byteLength,
      workflowId: null,
      detail: "selection is malformed JSON and cannot be migrated automatically",
    };
  }
  const legacy = parseLegacyWorkflowSelectionV0(value);
  if (legacy) {
    return {
      status: "legacy_v0",
      selectionPath,
      sha256: source.sha256,
      byteLength: source.bytes.byteLength,
      workflowId: legacy.workflowId,
      detail: "strict legacy v0 selection; eligible for explicit archival",
    };
  }
  if (isRecord(value) && typeof value.missionId === "string") {
    try {
      const trusted = assertTrustedSelectionDocument(
        workbench,
        value,
        value.missionId,
        source.text,
      );
      return {
        status: "trusted_v1",
        selectionPath,
        sha256: source.sha256,
        byteLength: source.bytes.byteLength,
        workflowId: trusted.workflowId,
        detail: "selection is backed by a trusted accepted experiment and must use rollback",
      };
    } catch {
      // Damaged or forged v1-like documents are unsupported, never legacy.
    }
  }
  return {
    status: "unsupported",
    selectionPath,
    sha256: source.sha256,
    byteLength: source.bytes.byteLength,
    workflowId: isRecord(value) && typeof value.workflowId === "string" ? value.workflowId : null,
    detail: "selection is neither strict legacy v0 nor a trusted v1 document",
  };
}

export function inspectWorkflowSelectionMigration(
  workbench: string,
): WorkflowSelectionMigrationInspection {
  assertNoWorkflowSelectionRecoveryState(workbench);
  const selectionPath = workflowSelectionPath(workbench);
  if (!pathEntryExists(selectionPath)) {
    return {
      status: "missing",
      selectionPath,
      sha256: null,
      byteLength: null,
      workflowId: null,
      detail: "no workflow selection is present",
    };
  }
  return classifyWorkflowSelection(
    workbench,
    readMigrationSelectionSource(selectionPath, "Workflow selection migration source"),
  );
}

function normalizeExpectedSha(value: string): string {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error("expectedSha256 must be an exact SHA-256");
  }
  return value.toLowerCase();
}

function validateMigrationReason(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 500 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Migration reason must be trimmed, non-empty, and at most 500 characters");
  }
  return value;
}

function archiveRelativePath(selectionSha256: string): string {
  return `state/workflow-selection-archive/${selectionSha256}.json`;
}

function parseMigrationReceipt(
  raw: string,
  expectedSha256: string,
  legacy: LegacyWorkflowSelectionV0,
  archiveBytes: Buffer,
): WorkflowSelectionMigrationReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("Workflow selection migration receipt is malformed", { cause: error });
  }
  if (!isRecord(value)) throw new Error("Workflow selection migration receipt must be an object");
  assertExactKeys(value, MIGRATION_RECEIPT_KEYS, "Workflow selection migration receipt");
  if (
    value.receiptVersion !== WORKFLOW_SELECTION_MIGRATION_RECEIPT_VERSION ||
    value.receiptKind !== "workflow-selection-legacy-archive" ||
    value.sourceRelativePath !== "state/workflow-selection.json" ||
    value.archiveRelativePath !== archiveRelativePath(expectedSha256) ||
    value.selectionSha256 !== expectedSha256 ||
    value.selectionByteLength !== archiveBytes.byteLength ||
    value.legacySchemaVersion !== 0 ||
    value.legacyWorkflowId !== legacy.workflowId
  ) {
    throw new Error("Workflow selection migration receipt binding is invalid");
  }
  validateMigrationReason(value.operatorReason as string);
  assertIso(value.archivedAt, "Workflow selection migration receipt archivedAt");
  return value as unknown as WorkflowSelectionMigrationReceipt;
}

function ensureMigrationArchiveDirectory(target: string): void {
  const root = path.dirname(target);
  if (!pathEntryExists(root)) mkdirSync(root);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Workflow selection archive directory must be a regular directory");
  }
}

function readPidMarker(filePath: string): number | null {
  if (!pathEntryExists(filePath)) return null;
  const raw = readControlText(
    filePath,
    "Workflow selection migration daemon marker",
    MAX_SELECTION_LOCK_BYTES,
  ).trim();
  let pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown };
      pid = Number(parsed?.pid);
    } catch {
      throw new Error(`Cannot prove daemon marker is inactive: ${filePath}`);
    }
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Cannot prove daemon marker is inactive: ${filePath}`);
  }
  return processAlive(pid) ? pid : null;
}

function assertWorkflowSelectionMigrationQuiescent(workbench: string): void {
  const state = path.join(workbench, "state");
  for (const name of [
    "agi-daemon.pid",
    "book-daemon.pid",
    "daemon.pid",
    "daily-juno.pid",
    "juno-daemon.pid",
  ]) {
    const marker = path.join(state, name);
    const pid = readPidMarker(marker);
    if (pid) throw new Error(`Workflow selection migration requires stopped daemons: ${name} pid=${pid}`);
  }
  const autonomyLock = path.join(state, "autonomy.lock.json");
  const autonomyPid = readPidMarker(autonomyLock);
  if (autonomyPid) {
    throw new Error(`Workflow selection migration requires an idle autonomy lock: pid=${autonomyPid}`);
  }
  const launcherRoot = path.join(state, "run-launchers");
  if (pathEntryExists(launcherRoot)) {
    const launcherStat = lstatSync(launcherRoot);
    if (!launcherStat.isDirectory() || launcherStat.isSymbolicLink()) {
      throw new Error("Cannot prove run launcher directory is quiescent");
    }
    for (const name of readdirSync(launcherRoot)) {
      if (!name.endsWith(".lock.json") && !name.endsWith(".lock.json.recovery")) continue;
      const pid = readPidMarker(path.join(launcherRoot, name));
      if (pid) {
        throw new Error(`Workflow selection migration requires idle run launchers: ${name} pid=${pid}`);
      }
    }
  }
  const orchestratorStatePath = path.join(state, "orchestrator.json");
  if (pathEntryExists(orchestratorStatePath)) {
    let orchestratorState: unknown;
    try {
      orchestratorState = JSON.parse(
        readControlText(
          orchestratorStatePath,
          "Workflow selection migration orchestrator state",
          MAX_CONTROL_RECORD_BYTES,
        ),
      );
    } catch (error) {
      throw new Error("Cannot prove orchestrator state is idle", { cause: error });
    }
    if (
      !isRecord(orchestratorState) ||
      (orchestratorState.activeRunId !== null && orchestratorState.activeRunId !== undefined) ||
      (orchestratorState.activeRunStatus !== undefined &&
        !["idle", "done", "complete"].includes(String(orchestratorState.activeRunStatus).toLowerCase()))
    ) {
      throw new Error("Workflow selection migration requires an idle orchestrator state");
    }
  }
  for (const experimentId of listWorkflowExperimentIds(workbench)) {
    const { proposal, sha256 } = readProposal(workbench, experimentId);
    if (readRunning(workbench, experimentId, sha256) && !readDecision(workbench, proposal, sha256)) {
      throw new Error(`Workflow selection migration refuses running experiment: ${experimentId}`);
    }
  }
}

function readLegacyArchive(
  archivePath: string,
  expectedSha256: string,
): { bytes: Buffer; legacy: LegacyWorkflowSelectionV0 } {
  const source = readMigrationSelectionSource(archivePath, "Workflow selection legacy archive");
  if (source.sha256 !== expectedSha256) {
    throw new Error("Workflow selection legacy archive hash conflicts with expected SHA-256");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.text);
  } catch {
    throw new Error("Workflow selection legacy archive is malformed");
  }
  const legacy = parseLegacyWorkflowSelectionV0(parsed);
  if (!legacy) throw new Error("Workflow selection legacy archive is not strict legacy v0");
  return { bytes: source.bytes, legacy };
}

function migrationResult(
  status: WorkflowSelectionMigrationResult["status"],
  archivePath: string,
  receiptPath: string,
  receiptSha256: string,
  receipt: WorkflowSelectionMigrationReceipt,
): WorkflowSelectionMigrationResult {
  return {
    status,
    archivePath,
    receiptPath,
    receiptSha256,
    receipt,
  };
}

export function migrateLegacyWorkflowSelection(
  workbench: string,
  input: { expectedSha256: string; reason: string },
): WorkflowSelectionMigrationResult {
  const expectedSha256 = normalizeExpectedSha(input.expectedSha256);
  const reason = validateMigrationReason(input.reason);
  const target = workflowSelectionPath(workbench);
  const paths = workflowSelectionArchivePaths(workbench, expectedSha256);
  return withSelectionLease(workbench, (lease) => {
    assertNoWorkflowSelectionRecoveryState(workbench);
    assertWorkflowSelectionMigrationQuiescent(workbench);
    const archiveExists = pathEntryExists(paths.archive);
    const receiptExists = pathEntryExists(paths.receipt);
    const sourceExists = pathEntryExists(target);

    if (receiptExists && !archiveExists) {
      throw new Error("Migration receipt exists without its immutable legacy archive");
    }

    let archive: { bytes: Buffer; legacy: LegacyWorkflowSelectionV0 } | null = null;
    if (archiveExists) archive = readLegacyArchive(paths.archive, expectedSha256);

    if (receiptExists) {
      if (sourceExists) {
        throw new Error("Archived workflow selection was recreated after migration");
      }
      const receiptSnapshot = readFileSnapshot(
        paths.receipt,
        "Workflow selection migration receipt",
        MAX_CONTROL_RECORD_BYTES,
      );
      if (!receiptSnapshot) {
        throw new Error("Workflow selection migration receipt disappeared while being read");
      }
      const receipt = parseMigrationReceipt(
        receiptSnapshot.raw,
        expectedSha256,
        archive!.legacy,
        archive!.bytes,
      );
      return migrationResult(
        "already_archived",
        paths.archive,
        paths.receipt,
        receiptSnapshot.sha256,
        receipt,
      );
    }

    let source: MigrationSelectionSource | null = null;
    let legacy: LegacyWorkflowSelectionV0;
    if (sourceExists) {
      source = readMigrationSelectionSource(target, "Workflow selection migration source");
      const inspection = classifyWorkflowSelection(workbench, source);
      if (inspection.sha256 !== expectedSha256) {
        throw new Error(
          `Workflow selection SHA-256 mismatch: expected ${expectedSha256}, observed ${inspection.sha256}`,
        );
      }
      if (inspection.status !== "legacy_v0") {
        throw new Error(`Only strict legacy v0 selections can be migrated: ${inspection.status}`);
      }
      legacy = parseLegacyWorkflowSelectionV0(JSON.parse(source.text))!;
      if (archive && !archive.bytes.equals(source.bytes)) {
        throw new Error("Existing workflow selection archive conflicts with the migration source");
      }
    } else {
      if (!archive) throw new Error("Workflow selection is missing and no recoverable archive exists");
      legacy = archive.legacy;
    }

    ensureMigrationArchiveDirectory(paths.archive);
    if (!archive) {
      writeFileSync(paths.archive, source!.bytes, { flag: "wx" });
      archive = readLegacyArchive(paths.archive, expectedSha256);
    }

    if (source) {
      assertSelectionLeaseOwned(lease);
      const current = readMigrationSelectionSource(target, "Workflow selection migration source");
      if (
        current.sha256 !== expectedSha256 ||
        !sameFileSnapshot(source.snapshot, current.snapshot) ||
        !current.bytes.equals(source.bytes)
      ) {
        throw new Error("Workflow selection changed before migration commit");
      }
      removeSelectionLocked(lease, target, source.text);
    }
    if (pathEntryExists(target)) {
      throw new Error("Workflow selection migration did not remove the exact source");
    }

    const receipt: WorkflowSelectionMigrationReceipt = {
      receiptVersion: WORKFLOW_SELECTION_MIGRATION_RECEIPT_VERSION,
      receiptKind: "workflow-selection-legacy-archive",
      sourceRelativePath: "state/workflow-selection.json",
      archiveRelativePath: archiveRelativePath(expectedSha256),
      selectionSha256: expectedSha256,
      selectionByteLength: archive.bytes.byteLength,
      legacySchemaVersion: 0,
      legacyWorkflowId: legacy.workflowId,
      operatorReason: reason,
      archivedAt: new Date().toISOString(),
    };
    const receiptText = canonicalJson(receipt);
    writeFileSync(paths.receipt, receiptText, { encoding: "utf8", flag: "wx" });
    const committedSnapshot = readFileSnapshot(
      paths.receipt,
      "Workflow selection migration receipt",
      MAX_CONTROL_RECORD_BYTES,
    );
    if (!committedSnapshot) {
      throw new Error("Workflow selection migration receipt disappeared after commit");
    }
    const committed = parseMigrationReceipt(
      committedSnapshot.raw,
      expectedSha256,
      legacy,
      archive.bytes,
    );
    if (pathEntryExists(target)) {
      throw new Error("Workflow selection was recreated while migration evidence was committed");
    }
    return migrationResult(
      "archived",
      paths.archive,
      paths.receipt,
      committedSnapshot.sha256,
      committed,
    );
  });
}

export function readTrustedWorkflowSelection(
  workbench: string,
  missionId: string,
): string | undefined {
  const lease = acquireSelectionLease(workbench);
  if (!lease) throw new Error("Workflow selection read is busy during mutation");
  try {
    return readTrustedWorkflowSelectionSnapshotLocked(workbench, missionId)?.workflowId;
  } finally {
    if (!releaseSelectionLease(lease)) {
      throw new Error("Lost workflow selection read lease ownership during release");
    }
  }
}

export function promoteWorkflowExperiment(
  workbench: string,
  experimentId: string,
  dependencies: WorkflowSelectionMutationDependencies = {},
): { workflowId: string; missionId: string } {
  const snapshot = evaluateWorkflowExperiment(workbench, experimentId);
  if (snapshot.status !== "accepted" || !snapshot.decision) {
    throw new Error(`Workflow experiment is not accepted: ${snapshot.status}`);
  }
  const decisionSnapshot = readCurrentDecisionSnapshot(
    workbench,
    snapshot.proposal,
    snapshot.proposalSha256,
  );
  if (!decisionSnapshot) throw new Error("Accepted workflow experiment decision is missing");
  const decisionSha256 = decisionSnapshot.sha256;
  const target = workflowSelectionPath(workbench);
  return withSelectionLease(workbench, (lease) => {
    const trusted = readTrustedWorkflowSelectionSnapshotLocked(
      workbench,
      snapshot.proposal.targetMissionId,
    );
    const current = trusted?.raw ?? null;
    if (trusted) {
      if (
        trusted.experimentId === experimentId &&
        trusted.decisionReceiptSha256 === decisionSha256
      ) {
        return {
          workflowId: snapshot.proposal.candidateWorkflowId,
          missionId: snapshot.proposal.targetMissionId,
        };
      }
    }
    const expected = previousSelectionText(snapshot.proposal.previousSelection);
    if (current !== expected) throw new Error("Workflow selection changed since experiment proposal");
    const live = collectMetrics(workbench, snapshot.proposal);
    if (!decisionMatchesLiveEvidence(snapshot.decision!, live)) {
      throw new Error("Workflow experiment evidence changed before first promotion");
    }
    replaceSelectionLocked(
      lease,
      target,
      canonicalJson(activeSelectionForExperiment(snapshot.proposal, decisionSha256)),
      expected,
      dependencies,
    );
    return {
      workflowId: snapshot.proposal.candidateWorkflowId,
      missionId: snapshot.proposal.targetMissionId,
    };
  });
}

export function rollbackWorkflowExperiment(
  workbench: string,
  experimentId: string,
  dependencies: WorkflowSelectionMutationDependencies = {},
): { restored: boolean } {
  const { proposal, sha256: proposalSha256 } = readProposal(workbench, experimentId);
  const decision = readAcceptedRollbackDecision(workbench, proposal, proposalSha256);
  if (!decision) {
    throw new Error("Only an accepted workflow experiment can be rolled back");
  }
  const decisionSha256 = decision.sha256;
  const target = workflowSelectionPath(workbench);
  return withSelectionLease(workbench, (lease) => {
    const trusted = readTrustedWorkflowSelectionSnapshotLocked(
      workbench,
      proposal.targetMissionId,
      { requireCurrentWorkflowHashes: false },
    );
    if (!trusted) throw new Error("Active workflow selection is missing");
    const current = trusted.raw;
    if (
      trusted.experimentId !== experimentId ||
      trusted.decisionReceiptSha256 !== decisionSha256
    ) {
      throw new Error("Active workflow selection belongs to another experiment");
    }
    const previous = previousSelectionText(proposal.previousSelection);
    if (previous !== null) {
      let previousValue: unknown;
      try {
        previousValue = JSON.parse(previous);
      } catch (error) {
        throw new Error("Previous workflow selection is unreadable", { cause: error });
      }
      if (!isRecord(previousValue)) throw new Error("Previous workflow selection is invalid");
      assertTrustedSelectionDocument(
        workbench,
        previousValue,
        proposal.targetMissionId,
        previous,
      );
      replaceSelectionLocked(lease, target, previous, current, dependencies);
    } else removeSelectionLocked(lease, target, current);
    return { restored: proposal.previousSelection.exists };
  });
}

export function listWorkflowExperimentIds(workbench: string): string[] {
  const root = experimentRoot(workbench);
  if (!existsSync(root)) return [];
  const ids: string[] = [];
  for (const name of readdirSync(root).filter((entry) => entry.endsWith(".proposal.json"))) {
    const filePath = path.join(root, name);
    try {
      const proposal = validateProposal(JSON.parse(readControlText(
        filePath,
        "Workflow experiment proposal",
        MAX_CONTROL_RECORD_BYTES,
      )));
      if (experimentKey(proposal.experimentId) === name.replace(/\.proposal\.json$/, "")) {
        ids.push(proposal.experimentId);
      }
    } catch {
      throw new Error(`Invalid workflow experiment proposal discovered: ${filePath}`);
    }
  }
  return ids.sort();
}
