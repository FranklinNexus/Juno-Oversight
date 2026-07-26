import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { hasUniqueCompleteStatus } from "./checkpoint-status.js";
import { readExclusiveControlText } from "./control-file.js";
import { verifyLiteratureArtifacts } from "./literature-verify.js";
import {
  parseNowYaml,
  queueItemFingerprint,
  readNowQueueSnapshot,
  recoverQueueHeadCommit,
  replaceQueueHeadConditionalWithCommit,
  type QueueRevision,
  type QueueSnapshot,
} from "./queue-io.js";
import { hasPassingVerifyEvidence } from "./review-loop.js";
import { runMissionDiffSafetyVerify, scanTextForSecrets } from "./safety-verify.js";
import type { QueueItem } from "./types.js";
import {
  ensureWorkbenchRootDirectory,
  resolveMissionDirectory,
  resolveRunDirectory,
  validateMissionDirectory,
  validateRunDirectory,
  validateWorkbenchRootDirectory,
} from "./workbench-paths.js";

export const MISSION_COMPLETION_RECEIPT_VERSION = 1 as const;
export const VERIFY_COMPLETION_INTENT_VERSION = 1 as const;
export const ORDINARY_VERIFY_EVIDENCE_VERSION = "ordinary-verify-v1";
const SPECIALIZED_COMPLETION_POLICIES = {
  "juno-agi-literature-2026": {
    evidenceVersion: "agi-literature-v1",
    terminalPhaseId: "ag83-verify",
  },
  "juno-axiom-book-2026": {
    evidenceVersion: "axiom-book-v1",
    terminalPhaseId: "ax46-verify",
  },
} as const;
const ORDINARY_COMPLETION_FORBIDDEN = new Set([
  ...Object.keys(SPECIALIZED_COMPLETION_POLICIES),
  // This is a maintenance state today, not a mission with a terminal verify run.
  "juno-book-quality-2026",
]);

export interface MissionCompletionReceipt {
  receiptVersion: typeof MISSION_COMPLETION_RECEIPT_VERSION;
  missionId: string;
  terminalRunId: string;
  runCheckpointSha256: string;
  evidenceVersion: string;
  completedAt: string;
}

interface MissionCompletionInput {
  missionId: string;
  terminalRunId: string;
  evidenceVersion: string;
}

export interface VerifyCompletionIntent {
  intentVersion: typeof VERIFY_COMPLETION_INTENT_VERSION;
  completionKind: "ordinary" | "specialized";
  missionId: string;
  terminalRunId: string;
  expectedQueueRevision: QueueRevision;
  expectedHeadFingerprint: string;
  expectedHead: QueueItem;
  missionCheckpointText?: string;
  receipt: MissionCompletionReceipt;
}

export type VerifyCompletionTransitionResult = ReturnType<
  typeof replaceQueueHeadConditionalWithCommit<MissionCompletionReceipt>
>;

export interface VerifyCompletionRecoveryResult {
  status: "none" | "recovered" | "busy" | "blocked";
  recovered: Array<{
    missionId: string;
    terminalRunId: string;
    mode: "dequeued_head" | "head_already_absent";
  }>;
  reason?: string;
}

export interface PendingVerifyCompletionIntentSnapshot {
  fileName: string;
  raw: string;
  sha256: string;
  intent: VerifyCompletionIntent;
}

const RECEIPT_KEYS = [
  "completedAt",
  "evidenceVersion",
  "missionId",
  "receiptVersion",
  "runCheckpointSha256",
  "terminalRunId",
] as const;
const INTENT_KEYS = [
  "completionKind",
  "expectedHead",
  "expectedHeadFingerprint",
  "expectedQueueRevision",
  "intentVersion",
  "missionCheckpointText",
  "missionId",
  "receipt",
  "terminalRunId",
] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_VERSION = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const MAX_INTENT_BYTES = 512 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_RUN_CHECKPOINT_BYTES = 4 * 1024 * 1024;

function specializedPolicy(missionId: string):
  | (typeof SPECIALIZED_COMPLETION_POLICIES)[keyof typeof SPECIALIZED_COMPLETION_POLICIES]
  | null {
  return Object.prototype.hasOwnProperty.call(SPECIALIZED_COMPLETION_POLICIES, missionId)
    ? SPECIALIZED_COMPLETION_POLICIES[
        missionId as keyof typeof SPECIALIZED_COMPLETION_POLICIES
      ]
    : null;
}

function expectedEvidenceVersion(missionId: string): string {
  const policy = specializedPolicy(missionId);
  if (policy) return policy.evidenceVersion;
  if (ORDINARY_COMPLETION_FORBIDDEN.has(missionId)) {
    throw new Error(`Mission has no supported completion receipt policy: ${missionId}`);
  }
  return ORDINARY_VERIFY_EVIDENCE_VERSION;
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertIsoDate(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new Error("completedAt must be an ISO timestamp");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error("completedAt must be a canonical ISO timestamp");
  }
}

function validateReceipt(value: unknown, expectedMissionId: string): MissionCompletionReceipt {
  if (!isRecord(value)) throw new Error("receipt must be a JSON object");
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...RECEIPT_KEYS].sort())) {
    throw new Error("receipt has missing or unknown fields");
  }
  if (value.receiptVersion !== MISSION_COMPLETION_RECEIPT_VERSION) {
    throw new Error(`unsupported receiptVersion: ${String(value.receiptVersion)}`);
  }
  if (value.missionId !== expectedMissionId) {
    throw new Error(`receipt missionId mismatch: ${String(value.missionId)}`);
  }
  if (typeof value.terminalRunId !== "string") {
    throw new Error("terminalRunId must be a string");
  }
  if (typeof value.runCheckpointSha256 !== "string" || !SHA256.test(value.runCheckpointSha256)) {
    throw new Error("runCheckpointSha256 must be a lowercase SHA-256 digest");
  }
  if (typeof value.evidenceVersion !== "string" || !EVIDENCE_VERSION.test(value.evidenceVersion)) {
    throw new Error("evidenceVersion is invalid");
  }
  const expectedVersion = expectedEvidenceVersion(expectedMissionId);
  if (value.evidenceVersion !== expectedVersion) {
    throw new Error(
      `receipt evidenceVersion mismatch: ${String(value.evidenceVersion)} != ${expectedVersion}`,
    );
  }
  assertIsoDate(value.completedAt);
  return value as unknown as MissionCompletionReceipt;
}

function completionDirectory(workbench: string): string {
  return path.join(workbench, "state", "mission-completions");
}

function completionIntentDirectory(workbench: string): string {
  return path.join(workbench, "state", "mission-completion-transactions");
}

function pathEntryExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function stateControlDirectory(
  workbench: string,
  name: "mission-completions" | "mission-completion-transactions",
  create: boolean,
): string | null {
  const lexicalState = path.join(path.resolve(workbench), "state");
  if (!create && !pathEntryExists(lexicalState)) return null;
  const state = create
    ? ensureWorkbenchRootDirectory(workbench, "state")
    : validateWorkbenchRootDirectory(workbench, "state");
  const directory = path.join(state, name);
  if (create && !pathEntryExists(directory)) mkdirSync(directory);
  if (!pathEntryExists(directory)) return null;
  assertRegularDirectory(directory, `Mission completion ${name} directory`);
  const canonical = realpathSync.native(directory);
  if (!samePath(canonical, directory) || !samePath(path.dirname(canonical), state)) {
    throw new Error(`Mission completion ${name} directory escapes Workbench state: ${directory}`);
  }
  return canonical;
}

function completionReceiptFile(workbench: string, missionId: string, create: boolean): string | null {
  const directory = stateControlDirectory(workbench, "mission-completions", create);
  return directory ? path.join(directory, `${hashText(missionId)}.json`) : null;
}

function completionIntentFile(workbench: string, missionId: string, create: boolean): string | null {
  const directory = stateControlDirectory(workbench, "mission-completion-transactions", create);
  return directory ? path.join(directory, `${hashText(missionId)}.json`) : null;
}

export function missionCompletionReceiptPath(workbench: string, missionId: string): string {
  resolveMissionDirectory(workbench, missionId);
  return path.join(completionDirectory(workbench), `${hashText(missionId)}.json`);
}

export function verifyCompletionIntentPath(workbench: string, missionId: string): string {
  resolveMissionDirectory(workbench, missionId);
  return path.join(completionIntentDirectory(workbench), `${hashText(missionId)}.json`);
}

function assertRegularDirectory(directory: string, label: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory: ${directory}`);
  }
}

const PUBLISH_TEMP_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Recover only the transaction's provable post-link/pre-unlink crash state. */
function recoverPublishedControlAlias(target: string, label: string, maxBytes: number): void {
  if (!pathEntryExists(target)) return;
  const targetStat = lstatSync(target, { bigint: true });
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) return;

  const base = path.basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\.${base}\\.[1-9][0-9]*\\.${PUBLISH_TEMP_UUID}\\.tmp$`);
  const directory = path.dirname(target);
  const candidates = readdirSync(directory).filter((name) => pattern.test(name));
  if (targetStat.nlink === BigInt(1)) {
    if (candidates.length > 0) {
      throw new Error(`${label} has an unproven publish temp: ${path.join(directory, candidates[0]!)}`);
    }
    return;
  }
  if (targetStat.nlink !== BigInt(2) || candidates.length !== 1) {
    throw new Error(`${label} must be an exclusive regular file; ambiguous publish state: ${target}`);
  }

  const candidate = path.join(directory, candidates[0]!);
  const candidateStat = lstatSync(candidate, { bigint: true });
  if (
    !candidateStat.isFile() ||
    candidateStat.isSymbolicLink() ||
    candidateStat.nlink !== BigInt(2) ||
    candidateStat.size > BigInt(maxBytes) ||
    targetStat.size !== candidateStat.size ||
    !sameInode(targetStat, candidateStat)
  ) {
    throw new Error(`${label} must be an exclusive regular file; publish alias is unproven: ${candidate}`);
  }

  const recoveryAlias = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  renameSync(candidate, recoveryAlias);
  try {
    const moved = lstatSync(recoveryAlias, { bigint: true });
    const current = lstatSync(target, { bigint: true });
    if (
      !moved.isFile() ||
      moved.isSymbolicLink() ||
      moved.nlink !== BigInt(2) ||
      current.nlink !== BigInt(2) ||
      !sameInode(moved, current) ||
      current.size !== moved.size
    ) {
      throw new Error(`${label} publish alias changed during recovery: ${target}`);
    }
    unlinkSync(recoveryAlias);
  } catch (error) {
    if (!pathEntryExists(candidate) && pathEntryExists(recoveryAlias)) {
      renameSync(recoveryAlias, candidate);
    }
    throw error;
  }
}

function readReceiptFile(receiptPath: string, missionId: string): MissionCompletionReceipt {
  recoverPublishedControlAlias(
    receiptPath,
    "Mission completion receipt",
    MAX_RECEIPT_BYTES,
  );
  const snapshot = readExclusiveControlText(
    receiptPath,
    "Mission completion receipt",
    MAX_RECEIPT_BYTES,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.text);
  } catch (error) {
    throw new Error(`Mission completion receipt is unreadable: ${receiptPath}`, { cause: error });
  }
  try {
    return validateReceipt(parsed, missionId);
  } catch (error) {
    throw new Error(`Mission completion receipt is invalid: ${receiptPath}`, { cause: error });
  }
}

function assertMissionCheckpointCandidate(text: string): void {
  if (!hasUniqueCompleteStatus(text)) {
    throw new Error("Specialized mission checkpoint must contain one exact STATUS: COMPLETE line");
  }
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
    throw new Error("Specialized mission checkpoint exceeds 64 KiB");
  }
  if (scanTextForSecrets(text).length > 0) {
    throw new Error("Specialized mission checkpoint contains possible secret material");
  }
}

function validateIntent(value: unknown, sourcePath: string): VerifyCompletionIntent {
  if (!isRecord(value)) throw new Error(`Verify completion intent must be an object: ${sourcePath}`);
  const unknown = Object.keys(value).filter(
    (key) => !(INTENT_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(`Verify completion intent has unknown fields: ${unknown.join(", ")}`);
  }
  const required = INTENT_KEYS.filter((key) => key !== "missionCheckpointText");
  const missing = required.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new Error(`Verify completion intent is missing fields: ${missing.join(", ")}`);
  }
  if (value.intentVersion !== VERIFY_COMPLETION_INTENT_VERSION) {
    throw new Error(`Unsupported verify completion intent version: ${String(value.intentVersion)}`);
  }
  if (value.completionKind !== "ordinary" && value.completionKind !== "specialized") {
    throw new Error("Verify completion intent completionKind is invalid");
  }
  if (typeof value.missionId !== "string" || typeof value.terminalRunId !== "string") {
    throw new Error("Verify completion intent mission/run binding is invalid");
  }
  const workbench = path.resolve(path.dirname(sourcePath), "..", "..");
  resolveMissionDirectory(workbench, value.missionId);
  resolveRunDirectory(workbench, value.terminalRunId);
  if (
    value.expectedQueueRevision !== null &&
    (typeof value.expectedQueueRevision !== "string" || !SHA256.test(value.expectedQueueRevision))
  ) {
    throw new Error("Verify completion intent expectedQueueRevision is invalid");
  }
  if (typeof value.expectedHeadFingerprint !== "string" || !SHA256.test(value.expectedHeadFingerprint)) {
    throw new Error("Verify completion intent head fingerprint is invalid");
  }
  if (!isRecord(value.expectedHead)) {
    throw new Error("Verify completion intent expectedHead is invalid");
  }
  const expectedHead = value.expectedHead as unknown as QueueItem;
  if (queueItemFingerprint(expectedHead) !== value.expectedHeadFingerprint) {
    throw new Error("Verify completion intent expectedHead fingerprint mismatch");
  }
  if (expectedHead.id !== value.terminalRunId || expectedHead.mission_id !== value.missionId) {
    throw new Error("Verify completion intent queue head binding mismatch");
  }
  const receipt = validateReceipt(value.receipt, value.missionId);
  if (receipt.terminalRunId !== value.terminalRunId) {
    throw new Error("Verify completion intent receipt run binding mismatch");
  }
  const policy = specializedPolicy(value.missionId);
  if (value.completionKind === "specialized") {
    if (!policy || typeof value.missionCheckpointText !== "string") {
      throw new Error("Specialized verify completion intent policy is invalid");
    }
    assertMissionCheckpointCandidate(value.missionCheckpointText);
  } else if (policy || value.missionCheckpointText !== undefined) {
    throw new Error("Ordinary verify completion intent policy is invalid");
  }
  return value as unknown as VerifyCompletionIntent;
}

function readCompletionIntentSnapshot(
  intentPath: string,
  recoverPublishAlias: boolean,
): { intent: VerifyCompletionIntent; raw: string; sha256: string } {
  if (recoverPublishAlias) {
    recoverPublishedControlAlias(intentPath, "Verify completion intent", MAX_INTENT_BYTES);
  }
  const { text: raw, sha256 } = readExclusiveControlText(
    intentPath,
    "Verify completion intent",
    MAX_INTENT_BYTES,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Verify completion intent is unreadable: ${intentPath}`, { cause: error });
  }
  return { intent: validateIntent(parsed, intentPath), raw, sha256 };
}

function readCompletionIntent(intentPath: string): { intent: VerifyCompletionIntent; raw: string } {
  return readCompletionIntentSnapshot(intentPath, true);
}

/** Inspect one canonical transaction file without repairing or removing any publish aliases. */
export function inspectPendingVerifyCompletionIntentFile(
  workbench: string,
  fileName: string,
): PendingVerifyCompletionIntentSnapshot | null {
  if (!/^[a-f0-9]{64}\.json$/.test(fileName) || path.basename(fileName) !== fileName) {
    throw new Error("Verify completion intent filename is invalid");
  }
  const directory = stateControlDirectory(workbench, "mission-completion-transactions", false);
  if (!directory) return null;
  const intentPath = path.join(directory, fileName);
  if (!pathEntryExists(intentPath)) return null;
  const snapshot = readCompletionIntentSnapshot(intentPath, false);
  if (fileName !== `${hashText(snapshot.intent.missionId)}.json`) {
    throw new Error(`Verify completion intent filename does not match mission binding: ${intentPath}`);
  }
  return { fileName, ...snapshot };
}

function readMissionCompletionReceiptEvidence(
  workbench: string,
  missionId: string,
): MissionCompletionReceipt | null {
  resolveMissionDirectory(workbench, missionId);
  const receiptPath = completionReceiptFile(workbench, missionId, false);
  if (!receiptPath || !pathEntryExists(receiptPath)) return null;
  validateMissionDirectory(workbench, missionId);
  const receipt = readReceiptFile(receiptPath, missionId);
  const lexicalRuns = path.join(path.resolve(workbench), "runs");
  const runs = pathEntryExists(lexicalRuns)
    ? validateWorkbenchRootDirectory(workbench, "runs")
    : null;
  const runDir = runs ? path.join(runs, receipt.terminalRunId) : null;
  const policy = specializedPolicy(missionId);
  if (runDir && pathEntryExists(runDir)) {
    validateRunDirectory(workbench, receipt.terminalRunId);
    assertMatchingVerifyManifest(
      workbench,
      missionId,
      receipt.terminalRunId,
      policy?.terminalPhaseId,
    );
    const checkpoint = checkpointForRun(workbench, receipt.terminalRunId);
    if (checkpoint.sha256 !== receipt.runCheckpointSha256) {
      throw new Error(`Retained terminal checkpoint no longer matches receipt: ${runDir}`);
    }
    if (!hasPassingVerifyEvidence(checkpoint.text)) {
      throw new Error(`Retained terminal checkpoint no longer passes verify: ${runDir}`);
    }
  }
  return receipt;
}

/** Missing means incomplete. Existing malformed or concurrently re-queued evidence fails closed. */
export function readMissionCompletionReceipt(
  workbench: string,
  missionId: string,
): MissionCompletionReceipt | null {
  const receipt = readMissionCompletionReceiptEvidence(workbench, missionId);
  if (!receipt) return null;
  const lexicalQueue = path.join(path.resolve(workbench), "queue");
  if (pathEntryExists(lexicalQueue)) validateWorkbenchRootDirectory(workbench, "queue");
  assertNoQueuedMission(readNowQueueSnapshot(workbench), missionId);
  return receipt;
}

function checkpointForRun(workbench: string, runId: string): { text: string; sha256: string } {
  const runDir = validateRunDirectory(workbench, runId);
  const checkpointPath = path.join(runDir, "checkpoint.md");
  if (!existsSync(checkpointPath)) {
    throw new Error(`Terminal run checkpoint is missing: ${checkpointPath}`);
  }
  const checkpoint = readExclusiveControlText(
    checkpointPath,
    "Terminal run checkpoint",
    MAX_RUN_CHECKPOINT_BYTES,
  );
  const text = checkpoint.text;
  if (!text.trim()) throw new Error("Terminal run checkpoint is empty");
  return { text, sha256: checkpoint.sha256 };
}

function assertMatchingVerifyManifest(
  workbench: string,
  missionId: string,
  terminalRunId: string,
  terminalPhaseId?: string,
): void {
  const manifestPath = path.join(validateRunDirectory(workbench, terminalRunId), "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Terminal verify manifest is missing: ${manifestPath}`);
  }
  const snapshot = readExclusiveControlText(
    manifestPath,
    "Terminal run manifest",
    MAX_MANIFEST_BYTES,
  );
  let manifest: unknown;
  try {
    manifest = JSON.parse(snapshot.text);
  } catch (error) {
    throw new Error(`Terminal run manifest is unreadable: ${manifestPath}`, { cause: error });
  }
  if (
    !isRecord(manifest) ||
    manifest.runId !== terminalRunId ||
    manifest.missionId !== missionId ||
    manifest.runKind !== "verify" ||
    (terminalPhaseId !== undefined && manifest.phaseId !== terminalPhaseId)
  ) {
    throw new Error("Mission receipt requires a matching terminal verify manifest");
  }
}

function assertSpecializedDomainEvidence(workbench: string, missionId: string): void {
  const failed = verifyLiteratureArtifacts(workbench, missionId).filter((check) => !check.ok);
  if (failed.length > 0) {
    const detail = failed.slice(0, 3).map((check) => `${check.label}: ${check.detail}`).join("; ");
    throw new Error(`Specialized mission domain evidence failed: ${detail}`);
  }
}

function sameBinding(
  receipt: MissionCompletionReceipt,
  input: MissionCompletionInput,
  checkpointSha256: string,
): boolean {
  return (
    receipt.missionId === input.missionId &&
    receipt.terminalRunId === input.terminalRunId &&
    receipt.runCheckpointSha256 === checkpointSha256 &&
    receipt.evidenceVersion === input.evidenceVersion
  );
}

function sameReceiptEvidence(
  left: MissionCompletionReceipt,
  right: MissionCompletionReceipt,
): boolean {
  return (
    left.receiptVersion === right.receiptVersion &&
    left.missionId === right.missionId &&
    left.terminalRunId === right.terminalRunId &&
    left.runCheckpointSha256 === right.runCheckpointSha256 &&
    left.evidenceVersion === right.evidenceVersion
  );
}

function assertNoQueuedMission(snapshot: QueueSnapshot, missionId: string): void {
  if ([...snapshot.now, ...snapshot.backlog].some((item) => item.mission_id === missionId)) {
    throw new Error(`Mission still has queued work: ${missionId}`);
  }
}

function assertPreparedEvidence(workbench: string, intent: VerifyCompletionIntent): void {
  const policy = specializedPolicy(intent.missionId);
  assertMatchingVerifyManifest(
    workbench,
    intent.missionId,
    intent.terminalRunId,
    intent.completionKind === "specialized" ? policy?.terminalPhaseId : undefined,
  );
  const checkpoint = checkpointForRun(workbench, intent.terminalRunId);
  if (checkpoint.sha256 !== intent.receipt.runCheckpointSha256) {
    throw new Error("Prepared terminal checkpoint no longer matches completion intent");
  }
  if (!hasPassingVerifyEvidence(checkpoint.text)) {
    throw new Error("Prepared completion intent requires a passing VERIFY_REPORT");
  }
  const safety = runMissionDiffSafetyVerify(workbench, intent.missionId);
  if (!safety.ok) throw new Error("Prepared completion intent requires a passing safety report");
  if (intent.completionKind === "specialized") {
    if (!policy || intent.missionCheckpointText === undefined) {
      throw new Error(`No specialized completion policy is registered: ${intent.missionId}`);
    }
    assertMissionCheckpointCandidate(intent.missionCheckpointText);
    assertSpecializedDomainEvidence(workbench, intent.missionId);
  }
}

function sameIntentBinding(left: VerifyCompletionIntent, right: VerifyCompletionIntent): boolean {
  // The durable head/evidence binding survives unrelated queue revisions; finalize rebases by CAS.
  return (
    left.intentVersion === right.intentVersion &&
    left.completionKind === right.completionKind &&
    left.missionId === right.missionId &&
    left.terminalRunId === right.terminalRunId &&
    left.expectedHeadFingerprint === right.expectedHeadFingerprint &&
    left.missionCheckpointText === right.missionCheckpointText &&
    sameReceiptEvidence(left.receipt, right.receipt)
  );
}

function persistCompletionIntent(
  workbench: string,
  candidate: VerifyCompletionIntent,
): VerifyCompletionIntent {
  const directory = stateControlDirectory(
    workbench,
    "mission-completion-transactions",
    true,
  )!;
  const intentPath = path.join(directory, `${hashText(candidate.missionId)}.json`);
  if (pathEntryExists(intentPath)) {
    const existing = readCompletionIntent(intentPath).intent;
    if (sameIntentBinding(existing, candidate)) return existing;
    throw new Error(`Verify completion intent already exists with conflicting evidence: ${intentPath}`);
  }

  const tempPath = path.join(directory, `.${path.basename(intentPath)}.${process.pid}.${randomUUID()}.tmp`);
  const raw = `${JSON.stringify(candidate, null, 2)}\n`;
  if (Buffer.byteLength(raw, "utf8") > MAX_INTENT_BYTES) {
    throw new Error(`Verify completion intent exceeds ${MAX_INTENT_BYTES} bytes`);
  }
  try {
    writeFileSync(tempPath, raw, { encoding: "utf8", flag: "wx" });
    try {
      linkSync(tempPath, intentPath);
    } catch (error) {
      if (!existsSync(intentPath)) throw error;
      const existing = readCompletionIntent(intentPath).intent;
      if (sameIntentBinding(existing, candidate)) return existing;
      throw new Error(`Verify completion intent raced with conflicting evidence: ${intentPath}`, {
        cause: error,
      });
    }
  } finally {
    rmSync(tempPath, { force: true });
  }
  return readCompletionIntent(intentPath).intent;
}

function prepareVerifyCompletionIntent(
  workbench: string,
  input: {
    completionKind: "ordinary" | "specialized";
    missionId: string;
    terminalRunId: string;
    expectedQueueRevision: QueueRevision;
    expectedHead: QueueItem;
    missionCheckpointText?: string;
  },
): VerifyCompletionIntent {
  validateMissionDirectory(workbench, input.missionId);
  validateRunDirectory(workbench, input.terminalRunId);
  validateWorkbenchRootDirectory(workbench, "queue");
  if (input.expectedHead.id !== input.terminalRunId || input.expectedHead.mission_id !== input.missionId) {
    throw new Error("Verify completion transaction requires an exact mission queue-head binding");
  }
  const policy = specializedPolicy(input.missionId);
  if (input.completionKind === "ordinary") {
    if (ORDINARY_COMPLETION_FORBIDDEN.has(input.missionId)) {
      throw new Error(`Specialized mission requires domain completion evidence: ${input.missionId}`);
    }
    if (input.missionCheckpointText !== undefined) {
      throw new Error("Ordinary completion cannot bind a specialized mission checkpoint");
    }
  } else {
    if (!policy) throw new Error(`No specialized completion policy is registered: ${input.missionId}`);
    if (input.missionCheckpointText === undefined) {
      throw new Error("Specialized completion requires a mission checkpoint");
    }
    assertMissionCheckpointCandidate(input.missionCheckpointText);
  }

  const queue = readNowQueueSnapshot(workbench);
  if (queue.revision !== input.expectedQueueRevision) {
    throw new Error("Verify completion preparation rejected a stale queue revision");
  }
  if (
    !queue.now[0] ||
    queueItemFingerprint(queue.now[0]) !== queueItemFingerprint(input.expectedHead)
  ) {
    throw new Error("Verify completion preparation rejected a changed queue head");
  }
  assertNoQueuedMission(
    { ...queue, now: queue.now.slice(1) },
    input.missionId,
  );

  assertMatchingVerifyManifest(
    workbench,
    input.missionId,
    input.terminalRunId,
    input.completionKind === "specialized" ? policy?.terminalPhaseId : undefined,
  );
  const checkpoint = checkpointForRun(workbench, input.terminalRunId);
  const evidenceVersion =
    input.completionKind === "specialized"
      ? policy!.evidenceVersion
      : ORDINARY_VERIFY_EVIDENCE_VERSION;
  const candidate: VerifyCompletionIntent = {
    intentVersion: VERIFY_COMPLETION_INTENT_VERSION,
    completionKind: input.completionKind,
    missionId: input.missionId,
    terminalRunId: input.terminalRunId,
    expectedQueueRevision: input.expectedQueueRevision,
    expectedHeadFingerprint: queueItemFingerprint(input.expectedHead),
    expectedHead: input.expectedHead,
    ...(input.missionCheckpointText === undefined
      ? {}
      : { missionCheckpointText: input.missionCheckpointText }),
    receipt: {
      receiptVersion: MISSION_COMPLETION_RECEIPT_VERSION,
      missionId: input.missionId,
      terminalRunId: input.terminalRunId,
      runCheckpointSha256: checkpoint.sha256,
      evidenceVersion,
      completedAt: new Date().toISOString(),
    },
  };
  assertPreparedEvidence(workbench, candidate);
  return persistCompletionIntent(workbench, candidate);
}

function installPreparedReceipt(
  workbench: string,
  candidate: MissionCompletionReceipt,
): MissionCompletionReceipt {
  const directory = stateControlDirectory(workbench, "mission-completions", true)!;
  const receiptPath = path.join(directory, `${hashText(candidate.missionId)}.json`);
  if (pathEntryExists(receiptPath)) {
    const existing = readReceiptFile(receiptPath, candidate.missionId);
    if (sameReceiptEvidence(existing, candidate)) return existing;
    throw new Error(`Mission completion receipt already exists with conflicting evidence: ${receiptPath}`);
  }
  const tempPath = path.join(directory, `.${path.basename(receiptPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(candidate, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      linkSync(tempPath, receiptPath);
    } catch (error) {
      if (!existsSync(receiptPath)) throw error;
      const existing = readReceiptFile(receiptPath, candidate.missionId);
      if (sameReceiptEvidence(existing, candidate)) return existing;
      throw new Error(`Mission completion receipt raced with conflicting evidence: ${receiptPath}`, {
        cause: error,
      });
    }
  } finally {
    rmSync(tempPath, { force: true });
  }
  // linkSync is the commit point. Avoid adding a fallible operation after it in the transaction.
  return candidate;
}

function writeSpecializedMissionCheckpoint(workbench: string, intent: VerifyCompletionIntent): void {
  if (intent.completionKind !== "specialized" || intent.missionCheckpointText === undefined) return;
  const missionDir = validateMissionDirectory(workbench, intent.missionId);
  const missionCheckpointPath = path.join(missionDir, "checkpoint.md");
  if (existsSync(missionCheckpointPath)) {
    const current = readExclusiveControlText(
      missionCheckpointPath,
      "Mission checkpoint",
      64 * 1024,
    ).text;
    if (current === intent.missionCheckpointText) return;
    throw new Error("Specialized mission checkpoint conflicts with prepared completion evidence");
  }
  const tempPath = path.join(
    missionDir,
    `.checkpoint.md.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tempPath, intent.missionCheckpointText, { encoding: "utf8", flag: "wx" });
    try {
      linkSync(tempPath, missionCheckpointPath);
    } catch (error) {
      if (!pathEntryExists(missionCheckpointPath)) throw error;
      const current = readExclusiveControlText(
        missionCheckpointPath,
        "Mission checkpoint",
        64 * 1024,
      ).text;
      if (current === intent.missionCheckpointText) return;
      throw new Error(
        "Specialized mission checkpoint raced with foreign evidence",
        { cause: error },
      );
    }
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function commitPreparedIntent(
  workbench: string,
  intent: VerifyCompletionIntent,
  queue: QueueSnapshot,
): MissionCompletionReceipt {
  const observed = readNowQueueSnapshot(workbench);
  if (observed.revision !== queue.revision) {
    throw new Error("Queue changed while committing verify completion evidence");
  }
  assertNoQueuedMission(observed, intent.missionId);
  assertPreparedEvidence(workbench, intent);
  writeSpecializedMissionCheckpoint(workbench, intent);
  return installPreparedReceipt(workbench, intent.receipt);
}

function removeIntentSnapshot(intentPath: string, expectedRaw: string): boolean {
  if (!existsSync(intentPath)) return true;
  const before = lstatSync(intentPath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    readExclusiveControlText(intentPath, "Verify completion intent", MAX_INTENT_BYTES).text !==
      expectedRaw
  ) {
    return false;
  }
  const quarantine = `${intentPath}.completed-${process.pid}-${randomUUID()}`;
  try {
    renameSync(intentPath, quarantine);
    const moved = lstatSync(quarantine);
    if (
      !moved.isFile() ||
      moved.isSymbolicLink() ||
      moved.dev !== before.dev ||
      moved.ino !== before.ino ||
      readExclusiveControlText(quarantine, "Verify completion intent", MAX_INTENT_BYTES).text !==
        expectedRaw
    ) {
      if (!existsSync(intentPath)) renameSync(quarantine, intentPath);
      return false;
    }
    rmSync(quarantine, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function tryRemoveIntentSnapshot(intentPath: string, expectedRaw: string): boolean {
  try {
    return removeIntentSnapshot(intentPath, expectedRaw);
  } catch {
    // Receipt + queue state are already authoritative; startup reconciliation may retry cleanup.
    return false;
  }
}

/**
 * Issue immutable control-plane evidence. The referenced run is verified and hashed at issue time;
 * later run retention/purge does not invalidate an already strict receipt.
 */
function issueMissionCompletionReceipt(
  workbench: string,
  input: MissionCompletionInput,
): MissionCompletionReceipt {
  validateMissionDirectory(workbench, input.missionId);
  validateRunDirectory(workbench, input.terminalRunId);
  const expectedVersion = expectedEvidenceVersion(input.missionId);
  if (input.evidenceVersion !== expectedVersion) {
    throw new Error(`Invalid evidenceVersion for ${input.missionId}: ${input.evidenceVersion}`);
  }
  const checkpoint = checkpointForRun(workbench, input.terminalRunId);
  const directory = stateControlDirectory(workbench, "mission-completions", true)!;
  const receiptPath = path.join(directory, `${hashText(input.missionId)}.json`);

  if (pathEntryExists(receiptPath)) {
    const existing = readReceiptFile(receiptPath, input.missionId);
    if (sameBinding(existing, input, checkpoint.sha256)) return existing;
    throw new Error(`Mission completion receipt already exists with conflicting evidence: ${receiptPath}`);
  }

  const receipt: MissionCompletionReceipt = {
    receiptVersion: MISSION_COMPLETION_RECEIPT_VERSION,
    missionId: input.missionId,
    terminalRunId: input.terminalRunId,
    runCheckpointSha256: checkpoint.sha256,
    evidenceVersion: input.evidenceVersion,
    completedAt: new Date().toISOString(),
  };
  const tempPath = path.join(directory, `.${path.basename(receiptPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      linkSync(tempPath, receiptPath);
    } catch (error) {
      if (!existsSync(receiptPath)) throw error;
      const existing = readReceiptFile(receiptPath, input.missionId);
      if (sameBinding(existing, input, checkpoint.sha256)) return existing;
      throw new Error(`Mission completion receipt raced with conflicting evidence: ${receiptPath}`, {
        cause: error,
      });
    }
  } finally {
    rmSync(tempPath, { force: true });
  }
  return readReceiptFile(receiptPath, input.missionId);
}

/** Domain completion path. Queue removal and all deterministic gates must precede this call. */
export function writeSpecializedVerifyCompletionReceipt(
  workbench: string,
  missionId: string,
  terminalRunId: string,
  missionCheckpointText: string,
): MissionCompletionReceipt {
  const policy = specializedPolicy(missionId);
  if (!policy) throw new Error(`No specialized completion policy is registered: ${missionId}`);
  const missionDir = validateMissionDirectory(workbench, missionId);
  validateWorkbenchRootDirectory(workbench, "queue");
  if (!hasUniqueCompleteStatus(missionCheckpointText)) {
    throw new Error("Specialized mission checkpoint must contain one exact STATUS: COMPLETE line");
  }
  if (Buffer.byteLength(missionCheckpointText, "utf8") > 64 * 1024) {
    throw new Error("Specialized mission checkpoint exceeds 64 KiB");
  }
  if (scanTextForSecrets(missionCheckpointText).length > 0) {
    throw new Error("Specialized mission checkpoint contains possible secret material");
  }
  assertMatchingVerifyManifest(
    workbench,
    missionId,
    terminalRunId,
    policy.terminalPhaseId,
  );
  const checkpoint = checkpointForRun(workbench, terminalRunId);
  if (!hasPassingVerifyEvidence(checkpoint.text)) {
    throw new Error("Specialized mission receipt requires a passing VERIFY_REPORT");
  }
  const safety = runMissionDiffSafetyVerify(workbench, missionId);
  if (!safety.ok) throw new Error("Specialized mission receipt requires a passing safety report");
  const { now, backlog } = parseNowYaml(workbench);
  if ([...now, ...backlog].some((item) => item.mission_id === missionId)) {
    throw new Error(`Specialized mission still has queued work: ${missionId}`);
  }
  assertSpecializedDomainEvidence(workbench, missionId);

  const missionCheckpointPath = path.join(missionDir, "checkpoint.md");
  if (existsSync(missionCheckpointPath)) {
    readExclusiveControlText(missionCheckpointPath, "Mission checkpoint", 64 * 1024);
  }
  writeFileSync(missionCheckpointPath, missionCheckpointText, "utf8");
  return issueMissionCompletionReceipt(workbench, {
    missionId,
    terminalRunId,
    evidenceVersion: policy.evidenceVersion,
  });
}

/** Parent-only ordinary completion path, called after the verified queue head is dequeued. */
export function writeOrdinaryVerifyCompletionReceipt(
  workbench: string,
  missionId: string,
  terminalRunId: string,
): MissionCompletionReceipt {
  if (ORDINARY_COMPLETION_FORBIDDEN.has(missionId)) {
    throw new Error(`Specialized mission requires domain completion evidence: ${missionId}`);
  }
  validateMissionDirectory(workbench, missionId);
  validateWorkbenchRootDirectory(workbench, "queue");
  assertMatchingVerifyManifest(workbench, missionId, terminalRunId);
  const checkpoint = checkpointForRun(workbench, terminalRunId);
  if (!hasPassingVerifyEvidence(checkpoint.text)) {
    throw new Error("Ordinary mission receipt requires a passing VERIFY_REPORT");
  }
  const safety = runMissionDiffSafetyVerify(workbench, missionId);
  if (!safety.ok) throw new Error("Ordinary mission receipt requires a passing safety report");
  const { now, backlog } = parseNowYaml(workbench);
  if ([...now, ...backlog].some((item) => item.mission_id === missionId)) {
    throw new Error(`Mission still has queued work: ${missionId}`);
  }
  return issueMissionCompletionReceipt(workbench, {
    missionId,
    terminalRunId,
    evidenceVersion: ORDINARY_VERIFY_EVIDENCE_VERSION,
  });
}

export function prepareOrdinaryVerifyCompletion(
  workbench: string,
  input: {
    expectedQueueRevision: QueueRevision;
    expectedHead: QueueItem;
  },
): VerifyCompletionIntent {
  if (!input.expectedHead.mission_id) {
    throw new Error("Ordinary verify completion requires a mission_id");
  }
  return prepareVerifyCompletionIntent(workbench, {
    completionKind: "ordinary",
    missionId: input.expectedHead.mission_id,
    terminalRunId: input.expectedHead.id,
    expectedQueueRevision: input.expectedQueueRevision,
    expectedHead: input.expectedHead,
  });
}

export function prepareSpecializedVerifyCompletion(
  workbench: string,
  input: {
    expectedQueueRevision: QueueRevision;
    expectedHead: QueueItem;
    missionCheckpointText: string;
  },
): VerifyCompletionIntent {
  if (!input.expectedHead.mission_id) {
    throw new Error("Specialized verify completion requires a mission_id");
  }
  return prepareVerifyCompletionIntent(workbench, {
    completionKind: "specialized",
    missionId: input.expectedHead.mission_id,
    terminalRunId: input.expectedHead.id,
    expectedQueueRevision: input.expectedQueueRevision,
    expectedHead: input.expectedHead,
    missionCheckpointText: input.missionCheckpointText,
  });
}

function finalizePreparedVerifyCompletion(
  workbench: string,
  intent: VerifyCompletionIntent,
): VerifyCompletionTransitionResult {
  const intentPath = completionIntentFile(workbench, intent.missionId, false);
  if (!intentPath || !pathEntryExists(intentPath)) {
    throw new Error(`Verify completion intent is missing: ${verifyCompletionIntentPath(workbench, intent.missionId)}`);
  }
  const snapshot = readCompletionIntent(intentPath);
  if (!sameIntentBinding(snapshot.intent, intent)) {
    throw new Error(`Verify completion intent changed before commit: ${intentPath}`);
  }
  const attempt = (expectedRevision: QueueRevision): VerifyCompletionTransitionResult =>
    replaceQueueHeadConditionalWithCommit(
      workbench,
      {
        expectedRevision,
        expectedHead: intent.expectedHead,
        replacement: [],
      },
      (queue) => commitPreparedIntent(workbench, intent, queue),
    );
  let result = attempt(intent.expectedQueueRevision);
  if (
    !result.ok &&
    result.reason === "revision_conflict" &&
    result.current.now[0] &&
    queueItemFingerprint(result.current.now[0]) === intent.expectedHeadFingerprint
  ) {
    result = attempt(result.current.revision);
  }
  if (result.ok) {
    // A leftover intent is harmless and will be removed by startup reconciliation.
    tryRemoveIntentSnapshot(intentPath, snapshot.raw);
  }
  return result;
}

export function finalizeOrdinaryVerifyQueueHead(
  workbench: string,
  input: {
    expectedQueueRevision: QueueRevision;
    expectedHead: QueueItem;
  },
): VerifyCompletionTransitionResult {
  return finalizePreparedVerifyCompletion(
    workbench,
    prepareOrdinaryVerifyCompletion(workbench, input),
  );
}

export function finalizeSpecializedVerifyQueueHead(
  workbench: string,
  input: {
    expectedQueueRevision: QueueRevision;
    expectedHead: QueueItem;
    missionCheckpointText: string;
  },
): VerifyCompletionTransitionResult {
  return finalizePreparedVerifyCompletion(
    workbench,
    prepareSpecializedVerifyCompletion(workbench, input),
  );
}

interface PendingCompletionIntentEntry {
  path: string;
  raw: string;
  sha256: string;
  intent: VerifyCompletionIntent;
}

function pendingCompletionIntents(workbench: string): PendingCompletionIntentEntry[] {
  const directory = stateControlDirectory(workbench, "mission-completion-transactions", false);
  if (!directory) return [];
  const pending: PendingCompletionIntentEntry[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!SHA256.test(path.basename(name, ".json")) || path.extname(name) !== ".json") continue;
    const intentPath = path.join(directory, name);
    const snapshot = readCompletionIntentSnapshot(intentPath, true);
    if (name !== `${hashText(snapshot.intent.missionId)}.json`) {
      throw new Error(`Verify completion intent filename does not match mission binding: ${intentPath}`);
    }
    pending.push({ path: intentPath, ...snapshot });
  }
  const head = readNowQueueSnapshot(workbench).now[0];
  const headFingerprint = head ? queueItemFingerprint(head) : null;
  return pending.sort((left, right) => {
    const leftAtHead = left.intent.expectedHeadFingerprint === headFingerprint ? 0 : 1;
    const rightAtHead = right.intent.expectedHeadFingerprint === headFingerprint ? 0 : 1;
    return leftAtHead - rightAtHead || left.path.localeCompare(right.path);
  });
}

function recoverCompletionIntentEntry(
  workbench: string,
  entry: PendingCompletionIntentEntry,
): VerifyCompletionRecoveryResult {
  let receiptPath: string | null = null;
  let receiptInspectionError: unknown;
  try {
    receiptPath = completionReceiptFile(workbench, entry.intent.missionId, false);
  } catch (error) {
    receiptInspectionError = error;
  }
  let committedReceipt: MissionCompletionReceipt | null = null;
  if (receiptPath && pathEntryExists(receiptPath)) {
    committedReceipt = readMissionCompletionReceiptEvidence(workbench, entry.intent.missionId);
    if (!committedReceipt || !sameReceiptEvidence(committedReceipt, entry.intent.receipt)) {
      return {
        status: "blocked",
        recovered: [],
        reason: `completion_receipt_conflict:${entry.intent.missionId}`,
      };
    }
  }

  const result = recoverQueueHeadCommit(workbench, entry.intent.expectedHead, (queue) => {
    const liveIntent = readCompletionIntentSnapshot(entry.path, false);
    if (
      liveIntent.sha256 !== entry.sha256 ||
      liveIntent.raw !== entry.raw ||
      !sameIntentBinding(liveIntent.intent, entry.intent)
    ) {
      throw new Error("Verify completion intent changed before recovery commit");
    }
    if (receiptInspectionError) throw receiptInspectionError;
    assertNoQueuedMission(queue, entry.intent.missionId);
    return committedReceipt ?? commitPreparedIntent(workbench, entry.intent, queue);
  });
  if (!result.ok) {
    if (result.reason === "busy") return { status: "busy", recovered: [] };
    const detail =
      result.reason === "commit_failed"
        ? result.error instanceof Error
          ? result.error.message
          : String(result.error)
        : "foreign queue state conflicts with prepared completion";
    return {
      status: "blocked",
      recovered: [],
      reason: `${result.reason}:${entry.intent.missionId}:${detail}`,
    };
  }
  tryRemoveIntentSnapshot(entry.path, entry.raw);
  return {
    status: "recovered",
    recovered: [{
      missionId: entry.intent.missionId,
      terminalRunId: entry.intent.terminalRunId,
      mode: result.mode,
    }],
  };
}

/** Recover exactly one immutable completion intent selected by mission and byte hash. */
export function recoverExactPendingVerifyCompletion(
  workbench: string,
  missionId: string,
  expectedIntentSha256: string,
): VerifyCompletionRecoveryResult {
  if (!SHA256.test(expectedIntentSha256)) {
    throw new Error("expectedIntentSha256 must be a lowercase SHA-256");
  }
  resolveMissionDirectory(workbench, missionId);
  const intentPath = completionIntentFile(workbench, missionId, false);
  if (!intentPath || !pathEntryExists(intentPath)) {
    return {
      status: "blocked",
      recovered: [],
      reason: `completion_intent_missing:${missionId}`,
    };
  }
  const snapshot = readCompletionIntentSnapshot(intentPath, false);
  if (snapshot.intent.missionId !== missionId || snapshot.sha256 !== expectedIntentSha256) {
    return {
      status: "blocked",
      recovered: [],
      reason: `completion_intent_conflict:${missionId}`,
    };
  }
  return recoverCompletionIntentEntry(workbench, { path: intentPath, ...snapshot });
}

export function recoverPendingVerifyCompletions(
  workbench: string,
): VerifyCompletionRecoveryResult {
  const lexicalQueue = path.join(path.resolve(workbench), "queue");
  if (pathEntryExists(lexicalQueue)) validateWorkbenchRootDirectory(workbench, "queue");
  const pending = pendingCompletionIntents(workbench);
  if (pending.length === 0) return { status: "none", recovered: [] };
  const recovered: VerifyCompletionRecoveryResult["recovered"] = [];

  for (const entry of pending) {
    const result = recoverCompletionIntentEntry(workbench, entry);
    if (result.status !== "recovered") {
      return {
        ...result,
        recovered,
      };
    }
    recovered.push(...result.recovered);
  }
  return { status: "recovered", recovered };
}
