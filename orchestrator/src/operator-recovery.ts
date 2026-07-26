import { createHash, randomUUID } from "node:crypto";
import {
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
import { readExclusiveControlText } from "./control-file.js";
import {
  inspectPendingVerifyCompletionIntentFile,
  readMissionCompletionReceipt,
  recoverExactPendingVerifyCompletion,
  type MissionCompletionReceipt,
  type VerifyCompletionRecoveryResult,
} from "./mission-completion.js";
import { parseQueueDocument } from "./queue-io.js";
import {
  ensureWorkbenchRootDirectory,
  validateWorkbenchRootDirectory,
  type WorkbenchRootName,
} from "./workbench-paths.js";

export const RECOVERY_INVENTORY_VERSION = 1 as const;

export type RecoveryDomainV1 =
  | "control_plane"
  | "queue"
  | "workflow_selection"
  | "completion";

export type RecoveryConfidenceV1 = "proven" | "ambiguous" | "invalid";
export type OperatorRecoveryActionV1 = "resume_exact_intent";

export interface RecoveryFileIdentityV1 {
  dev: string;
  ino: string;
  mode: string;
  nlink: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface RecoveryArtifactSnapshotV1 {
  relativePath: string;
  entryKind: "file" | "directory" | "symlink" | "other" | "missing";
  identity: RecoveryFileIdentityV1 | null;
  byteLength: number | null;
  sha256: string | null;
  validation:
    | "stable_file"
    | "unexpected_link_count"
    | "oversized"
    | "non_file"
    | "unreadable";
  detail?: string;
}

export interface RecoveryCompletionBindingV1 {
  missionId: string;
  terminalRunId: string;
  expectedHeadFingerprint: string;
  intentSha256: string;
  expectedReceipt: MissionCompletionReceipt;
}

export interface RecoveryIncidentV1 {
  incidentId: string;
  domain: RecoveryDomainV1;
  kind: string;
  blocking: true;
  confidence: RecoveryConfidenceV1;
  artifact: RecoveryArtifactSnapshotV1;
  detail: string;
  completionBinding?: RecoveryCompletionBindingV1;
  allowedActions: OperatorRecoveryActionV1[];
  preconditionSha256: string;
}

export interface RecoveryInventoryV1 {
  inventoryVersion: typeof RECOVERY_INVENTORY_VERSION;
  observedAt: string;
  workbench: string;
  controls: {
    queue: RecoveryArtifactSnapshotV1 | null;
    workflowSelection: RecoveryArtifactSnapshotV1 | null;
  };
  incidents: RecoveryIncidentV1[];
  inventorySha256: string;
}

export interface ApplyOperatorRecoveryInput {
  incidentId: string;
  action: OperatorRecoveryActionV1;
  preconditionSha256: string;
  reason: string;
}

export interface ApplyOperatorRecoveryResult {
  operationId: string;
  incidentId: string;
  action: OperatorRecoveryActionV1;
  reason: string;
  recovery: VerifyCompletionRecoveryResult;
}

interface CapturedArtifact {
  snapshot: RecoveryArtifactSnapshotV1;
  text: string | null;
}

interface IncidentDraft {
  domain: RecoveryDomainV1;
  kind: string;
  blocking: true;
  confidence: RecoveryConfidenceV1;
  artifact: RecoveryArtifactSnapshotV1;
  detail: string;
  completionBinding?: RecoveryCompletionBindingV1;
  allowedActions: OperatorRecoveryActionV1[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const INTENT_FILE = /^[a-f0-9]{64}\.json$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const COMPLETION_TEMP = new RegExp(`^\\.[a-f0-9]{64}\\.json\\.[1-9][0-9]*\\.${UUID}\\.tmp$`);
const COMPLETION_COMPLETED = new RegExp(`^[a-f0-9]{64}\\.json\\.completed-[1-9][0-9]*-${UUID}$`);
const QUEUE_TEMP = new RegExp(`^\\.now\\.yaml\\.[1-9][0-9]*\\.${UUID}\\.tmp$`);
const SELECTION_TEMP = new RegExp(`^\\.workflow-selection\\.json\\.[1-9][0-9]*\\.${UUID}\\.tmp$`);
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_SELECTION_BYTES = 64 * 1024;
const MAX_COMPLETION_BYTES = 512 * 1024;
const MAX_UNKNOWN_BYTES = 512 * 1024;
const MAX_JOURNAL_BYTES = 256 * 1024;
const OPERATOR_RECOVERY_JOURNAL_VERSION = 1 as const;

interface OperatorRecoveryJournalIntentV1 {
  journalVersion: typeof OPERATOR_RECOVERY_JOURNAL_VERSION;
  recordKind: "operator-recovery-intent";
  operationId: string;
  incidentId: string;
  action: OperatorRecoveryActionV1;
  preconditionSha256: string;
  reason: string;
  completionBinding: RecoveryCompletionBindingV1;
  createdAt: string;
}

interface OperatorRecoveryJournalReceiptV1 {
  journalVersion: typeof OPERATOR_RECOVERY_JOURNAL_VERSION;
  recordKind: "operator-recovery-receipt";
  operationId: string;
  intentSha256: string;
  recovery: VerifyCompletionRecoveryResult;
  completedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
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

function relativeControlPath(workbench: string, target: string): string {
  const relative = path.relative(path.resolve(workbench), target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Recovery artifact escapes Workbench: ${target}`);
  }
  return relative.split(path.sep).join("/");
}

function entryKind(stat: BigIntStats): RecoveryArtifactSnapshotV1["entryKind"] {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "other";
}

function identity(stat: BigIntStats): RecoveryFileIdentityV1 {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

function captureArtifact(
  workbench: string,
  target: string,
  label: string,
  maxBytes: number,
): CapturedArtifact {
  const relativePath = relativeControlPath(workbench, target);
  let stat: BigIntStats;
  try {
    stat = lstatSync(target, { bigint: true });
  } catch (error) {
    return {
      text: null,
      snapshot: {
        relativePath,
        entryKind: "missing",
        identity: null,
        byteLength: null,
        sha256: null,
        validation: "unreadable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const kind = entryKind(stat);
  const base = {
    relativePath,
    entryKind: kind,
    identity: identity(stat),
    byteLength: stat.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(stat.size) : null,
    sha256: null,
  } satisfies Omit<RecoveryArtifactSnapshotV1, "validation" | "detail">;
  if (kind !== "file") {
    return {
      text: null,
      snapshot: { ...base, validation: "non_file", detail: `${label} is not a regular file` },
    };
  }
  if (stat.nlink !== BigInt(1)) {
    return {
      text: null,
      snapshot: {
        ...base,
        validation: "unexpected_link_count",
        detail: `${label} has link count ${stat.nlink.toString()}`,
      },
    };
  }
  if (stat.size > BigInt(maxBytes)) {
    return {
      text: null,
      snapshot: { ...base, validation: "oversized", detail: `${label} exceeds ${maxBytes} bytes` },
    };
  }
  try {
    const control = readExclusiveControlText(target, label, maxBytes);
    return {
      text: control.text,
      snapshot: {
        ...base,
        byteLength: control.byteLength,
        sha256: control.sha256,
        validation: "stable_file",
      },
    };
  } catch (error) {
    return {
      text: null,
      snapshot: {
        ...base,
        validation: "unreadable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function incidentFingerprint(draft: IncidentDraft): string {
  return sha256(canonicalJson({
    domain: draft.domain,
    kind: draft.kind,
    blocking: draft.blocking,
    confidence: draft.confidence,
    artifact: draft.artifact,
    completionBinding: draft.completionBinding,
  }));
}

function invalidConfidence(artifact: RecoveryArtifactSnapshotV1): RecoveryConfidenceV1 {
  return artifact.validation === "stable_file" ? "ambiguous" : "invalid";
}

function addArtifactIncident(
  drafts: IncidentDraft[],
  domain: RecoveryDomainV1,
  kind: string,
  capture: CapturedArtifact,
  detail: string,
): void {
  drafts.push({
    domain,
    kind,
    blocking: true,
    confidence: invalidConfidence(capture.snapshot),
    artifact: capture.snapshot,
    detail,
    allowedActions: [],
  });
}

function inspectRoot(
  workbench: string,
  rootName: WorkbenchRootName,
  drafts: IncidentDraft[],
): string | null {
  const lexicalRoot = path.join(path.resolve(workbench), rootName);
  if (!pathEntryExists(lexicalRoot)) return null;
  try {
    return validateWorkbenchRootDirectory(workbench, rootName);
  } catch (error) {
    const capture = captureArtifact(workbench, lexicalRoot, `${rootName} root`, MAX_UNKNOWN_BYTES);
    drafts.push({
      domain: "control_plane",
      kind: `untrusted_${rootName}_root`,
      blocking: true,
      confidence: "invalid",
      artifact: capture.snapshot,
      detail: error instanceof Error ? error.message : String(error),
      allowedActions: [],
    });
    return null;
  }
}

function scanQueue(
  workbench: string,
  queueRoot: string | null,
  drafts: IncidentDraft[],
): { control: RecoveryArtifactSnapshotV1 | null; healthy: boolean } {
  if (!queueRoot) {
    const missing = captureArtifact(
      workbench,
      path.join(path.resolve(workbench), "queue", "now.yaml"),
      "Queue file",
      MAX_QUEUE_BYTES,
    );
    drafts.push({
      domain: "queue",
      kind: "queue_missing_control",
      blocking: true,
      confidence: "invalid",
      artifact: missing.snapshot,
      detail: "Canonical queue control file is missing or its root is untrusted",
      allowedActions: [],
    });
    return { control: null, healthy: false };
  }
  const queuePath = path.join(queueRoot, "now.yaml");
  let control: RecoveryArtifactSnapshotV1 | null = null;
  let healthy = false;
  if (pathEntryExists(queuePath)) {
    const captured = captureArtifact(workbench, queuePath, "Queue file", MAX_QUEUE_BYTES);
    control = captured.snapshot;
    if (captured.snapshot.validation === "stable_file" && captured.text !== null) {
      try {
        parseQueueDocument(captured.text, queuePath);
        healthy = true;
      } catch (error) {
        healthy = false;
        drafts.push({
          domain: "queue",
          kind: "queue_invalid_control",
          blocking: true,
          confidence: "invalid",
          artifact: captured.snapshot,
          detail: error instanceof Error ? error.message : String(error),
          allowedActions: [],
        });
      }
    } else {
      drafts.push({
        domain: "queue",
        kind: "queue_invalid_control",
        blocking: true,
        confidence: "invalid",
        artifact: captured.snapshot,
        detail: captured.snapshot.detail ?? "Canonical queue control file is not trusted",
        allowedActions: [],
      });
    }
  } else {
    const missing = captureArtifact(workbench, queuePath, "Queue file", MAX_QUEUE_BYTES);
    drafts.push({
      domain: "queue",
      kind: "queue_missing_control",
      blocking: true,
      confidence: "invalid",
      artifact: missing.snapshot,
      detail: "Canonical queue control file is missing",
      allowedActions: [],
    });
  }
  for (const name of readdirSync(queueRoot).sort()) {
    const target = path.join(queueRoot, name);
    if (name.startsWith("now.yaml.preimage-")) {
      addArtifactIncident(
        drafts,
        "queue",
        "queue_preimage",
        captureArtifact(workbench, target, "Queue preimage", MAX_QUEUE_BYTES),
        "Queue mutation preimage requires explicit operator resolution",
      );
      healthy = false;
    } else if (name.startsWith(".now.yaml.") && name.endsWith(".tmp")) {
      const captured = captureArtifact(workbench, target, "Queue publish temp", MAX_QUEUE_BYTES);
      addArtifactIncident(
        drafts,
        "queue",
        QUEUE_TEMP.test(name) ? "queue_publish_temp" : "queue_malformed_publish_temp",
        captured,
        "Queue publish temp is not trusted as a committed queue",
      );
      healthy = false;
    }
  }
  return { control, healthy };
}

function scanWorkflowSelection(
  workbench: string,
  stateRoot: string | null,
  drafts: IncidentDraft[],
): RecoveryArtifactSnapshotV1 | null {
  if (!stateRoot) return null;
  const selectionPath = path.join(stateRoot, "workflow-selection.json");
  const control = pathEntryExists(selectionPath)
    ? captureArtifact(workbench, selectionPath, "Workflow selection", MAX_SELECTION_BYTES).snapshot
    : null;
  for (const name of readdirSync(stateRoot).sort()) {
    let kind: string | null = null;
    if (name.startsWith("workflow-selection.json.preimage-")) {
      kind = "workflow_selection_preimage";
    } else if (name.startsWith("workflow-selection.json.rollback-")) {
      kind = "workflow_selection_rollback";
    } else if (name.startsWith(".workflow-selection.json.") && name.endsWith(".tmp")) {
      kind = SELECTION_TEMP.test(name)
        ? "workflow_selection_publish_temp"
        : "workflow_selection_malformed_publish_temp";
    } else if (name.startsWith("workflow-selection.lock.json.quarantine-")) {
      kind = "workflow_selection_lock_quarantine";
    } else if (name === "workflow-selection.lock.json.recovery") {
      kind = "workflow_selection_lock_recovery";
    }
    if (!kind) continue;
    addArtifactIncident(
      drafts,
      "workflow_selection",
      kind,
      captureArtifact(workbench, path.join(stateRoot, name), "Workflow selection recovery artifact", MAX_SELECTION_BYTES),
      "Workflow selection recovery state blocks trusted selection reads",
    );
  }
  return control;
}

function scanCompletionDirectory(
  workbench: string,
  stateRoot: string | null,
  drafts: IncidentDraft[],
): void {
  if (!stateRoot) return;
  const directory = path.join(stateRoot, "mission-completion-transactions");
  if (!pathEntryExists(directory)) return;
  let entries: string[];
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("transaction root is not a regular directory");
    entries = readdirSync(directory).sort();
  } catch (error) {
    const capture = captureArtifact(workbench, directory, "Completion transaction root", MAX_UNKNOWN_BYTES);
    drafts.push({
      domain: "completion",
      kind: "completion_untrusted_transaction_root",
      blocking: true,
      confidence: "invalid",
      artifact: capture.snapshot,
      detail: error instanceof Error ? error.message : String(error),
      allowedActions: [],
    });
    return;
  }

  const hasUnknownEntry = entries.some((name) =>
    !INTENT_FILE.test(name) &&
    !(name.startsWith(".") && name.endsWith(".tmp")) &&
    !name.includes(".completed-")
  );
  const relatedRecoveryEntries = new Set<string>();
  for (const name of entries) {
    if (name.startsWith(".") && name.endsWith(".tmp")) {
      const match = /^\.([a-f0-9]{64}\.json)\./.exec(name);
      if (match?.[1]) relatedRecoveryEntries.add(match[1]);
    } else {
      const match = /^([a-f0-9]{64}\.json)\.completed-/.exec(name);
      if (match?.[1]) relatedRecoveryEntries.add(match[1]);
    }
  }

  for (const name of entries) {
    const target = path.join(directory, name);
    const captured = captureArtifact(workbench, target, "Completion transaction artifact", MAX_COMPLETION_BYTES);
    if (INTENT_FILE.test(name)) {
      let inspectionError: unknown;
      let binding: RecoveryCompletionBindingV1 | undefined;
      try {
        const inspected = inspectPendingVerifyCompletionIntentFile(workbench, name);
        if (!inspected || inspected.sha256 !== captured.snapshot.sha256) {
          throw new Error("Completion intent changed during inventory inspection");
        }
        binding = {
          missionId: inspected.intent.missionId,
          terminalRunId: inspected.intent.terminalRunId,
          expectedHeadFingerprint: inspected.intent.expectedHeadFingerprint,
          intentSha256: inspected.sha256,
          expectedReceipt: inspected.intent.receipt,
        };
      } catch (error) {
        inspectionError = error;
      }
      const valid = Boolean(binding) && captured.snapshot.validation === "stable_file";
      drafts.push({
        domain: "completion",
        kind: valid ? "completion_pending_intent" : "completion_invalid_intent",
        blocking: true,
        confidence: valid ? "proven" : "invalid",
        artifact: captured.snapshot,
        detail: valid
          ? "Strict immutable completion intent is pending reconciliation"
          : inspectionError instanceof Error
            ? inspectionError.message
            : "Completion intent is not strictly valid",
        ...(binding ? { completionBinding: binding } : {}),
        allowedActions:
          valid && !hasUnknownEntry && !relatedRecoveryEntries.has(name)
            ? ["resume_exact_intent"]
            : [],
      });
    } else if (name.startsWith(".") && name.endsWith(".tmp")) {
      addArtifactIncident(
        drafts,
        "completion",
        COMPLETION_TEMP.test(name) ? "completion_publish_temp" : "completion_malformed_publish_temp",
        captured,
        "Completion publish temp is never promoted by inventory recovery",
      );
    } else if (name.includes(".completed-")) {
      addArtifactIncident(
        drafts,
        "completion",
        COMPLETION_COMPLETED.test(name)
          ? "completion_completed_quarantine"
          : "completion_malformed_completed_quarantine",
        captured,
        "Completion cleanup quarantine requires separate evidence-backed archival",
      );
    } else {
      addArtifactIncident(
        drafts,
        "completion",
        "completion_unknown_transaction_entry",
        captured,
        "Unknown completion transaction entry blocks automatic recovery",
      );
    }
  }
}

function scanCompletionReceiptArtifacts(
  workbench: string,
  stateRoot: string | null,
  drafts: IncidentDraft[],
): void {
  if (!stateRoot) return;
  const directory = path.join(stateRoot, "mission-completions");
  if (!pathEntryExists(directory)) return;
  let entries: string[];
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("receipt root is not a regular directory");
    entries = readdirSync(directory).sort();
  } catch (error) {
    const capture = captureArtifact(workbench, directory, "Completion receipt root", MAX_UNKNOWN_BYTES);
    drafts.push({
      domain: "completion",
      kind: "completion_untrusted_receipt_root",
      blocking: true,
      confidence: "invalid",
      artifact: capture.snapshot,
      detail: error instanceof Error ? error.message : String(error),
      allowedActions: [],
    });
    return;
  }
  for (const name of entries) {
    if (INTENT_FILE.test(name)) continue;
    const target = path.join(directory, name);
    const captured = captureArtifact(workbench, target, "Completion receipt artifact", MAX_COMPLETION_BYTES);
    if (name.startsWith(".") && name.endsWith(".tmp")) {
      addArtifactIncident(
        drafts,
        "completion",
        COMPLETION_TEMP.test(name) ? "completion_receipt_publish_temp" : "completion_receipt_malformed_publish_temp",
        captured,
        "Completion receipt publish temp requires explicit resolution",
      );
    } else {
      addArtifactIncident(
        drafts,
        "completion",
        "completion_unknown_receipt_entry",
        captured,
        "Unknown completion receipt entry blocks automatic recovery",
      );
    }
  }
}

export function inspectOperatorRecovery(workbench: string): RecoveryInventoryV1 {
  const resolvedWorkbench = path.resolve(workbench);
  const drafts: IncidentDraft[] = [];
  const queueRoot = inspectRoot(resolvedWorkbench, "queue", drafts);
  const stateRoot = inspectRoot(resolvedWorkbench, "state", drafts);
  const queue = scanQueue(resolvedWorkbench, queueRoot, drafts);
  const workflowSelection = scanWorkflowSelection(resolvedWorkbench, stateRoot, drafts);
  scanCompletionDirectory(resolvedWorkbench, stateRoot, drafts);
  scanCompletionReceiptArtifacts(resolvedWorkbench, stateRoot, drafts);

  const hasCompletionRecoveryAnomaly = drafts.some(
    (draft) => draft.domain === "completion" && draft.kind !== "completion_pending_intent",
  );
  if (!queue.healthy || hasCompletionRecoveryAnomaly) {
    for (const draft of drafts) {
      if (draft.kind === "completion_pending_intent") draft.allowedActions = [];
    }
  }
  const sortedDrafts = drafts.sort((left, right) =>
    left.artifact.relativePath.localeCompare(right.artifact.relativePath) ||
    left.kind.localeCompare(right.kind)
  );
  const incidentBases = sortedDrafts.map((draft) => ({
    ...draft,
    incidentId: incidentFingerprint(draft),
  }));
  const fingerprintPayload = {
    inventoryVersion: RECOVERY_INVENTORY_VERSION,
    workbench: resolvedWorkbench,
    controls: {
      queue: queue.control,
      workflowSelection,
    },
    incidents: incidentBases,
  };
  const inventorySha256 = sha256(canonicalJson(fingerprintPayload));
  return {
    inventoryVersion: RECOVERY_INVENTORY_VERSION,
    observedAt: new Date().toISOString(),
    workbench: resolvedWorkbench,
    controls: fingerprintPayload.controls,
    incidents: incidentBases.map((incident) => ({
      ...incident,
      preconditionSha256: inventorySha256,
    })),
    inventorySha256,
  };
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function validateJournalChildDirectory(parent: string, name: string): string | null {
  const target = path.join(parent, name);
  if (!pathEntryExists(target)) return null;
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Operator recovery journal directory is not trusted: ${target}`);
  }
  const canonical = realpathSync.native(target);
  if (!samePath(canonical, target) || !samePath(path.dirname(canonical), parent)) {
    throw new Error(`Operator recovery journal directory escapes its trusted parent: ${target}`);
  }
  return canonical;
}

function ensureJournalChildDirectory(parent: string, name: string): string {
  const existing = validateJournalChildDirectory(parent, name);
  if (existing) return existing;
  const target = path.join(parent, name);
  try {
    mkdirSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const created = validateJournalChildDirectory(parent, name);
  if (!created) throw new Error(`Operator recovery journal directory was not created: ${target}`);
  return created;
}

function existingJournalPaths(
  workbench: string,
  operationId: string,
): { intent: string; receipt: string } | null {
  const lexicalState = path.join(path.resolve(workbench), "state");
  if (!pathEntryExists(lexicalState)) return null;
  const state = validateWorkbenchRootDirectory(workbench, "state");
  const root = validateJournalChildDirectory(state, "operator-recovery");
  if (!root) return null;
  const version = validateJournalChildDirectory(root, "v1");
  if (!version) return null;
  return {
    intent: path.join(version, `${operationId}.intent.json`),
    receipt: path.join(version, `${operationId}.receipt.json`),
  };
}

function createJournalPaths(
  workbench: string,
  operationId: string,
): { intent: string; receipt: string } {
  const state = ensureWorkbenchRootDirectory(workbench, "state");
  const root = ensureJournalChildDirectory(state, "operator-recovery");
  const version = ensureJournalChildDirectory(root, "v1");
  return {
    intent: path.join(version, `${operationId}.intent.json`),
    receipt: path.join(version, `${operationId}.receipt.json`),
  };
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function recoverJournalPublishAlias(target: string): void {
  if (!pathEntryExists(target)) return;
  const targetStat = lstatSync(target, { bigint: true });
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error(`Operator recovery journal must be a regular file: ${target}`);
  }
  const escaped = path.basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\.${escaped}\\.[1-9][0-9]*\\.${UUID}\\.tmp$`);
  const directory = path.dirname(target);
  const candidates = readdirSync(directory).filter((name) => pattern.test(name));
  if (targetStat.nlink === BigInt(1) && candidates.length === 0) return;
  if (targetStat.nlink !== BigInt(2) || candidates.length !== 1) {
    throw new Error(`Operator recovery journal has ambiguous publish state: ${target}`);
  }
  const candidate = path.join(directory, candidates[0]!);
  const candidateStat = lstatSync(candidate, { bigint: true });
  if (
    !candidateStat.isFile() ||
    candidateStat.isSymbolicLink() ||
    candidateStat.nlink !== BigInt(2) ||
    candidateStat.size !== targetStat.size ||
    candidateStat.size > BigInt(MAX_JOURNAL_BYTES) ||
    !sameInode(candidateStat, targetStat)
  ) {
    throw new Error(`Operator recovery journal publish alias is not proven: ${candidate}`);
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
      moved.nlink !== BigInt(2) ||
      current.nlink !== BigInt(2) ||
      moved.size !== current.size ||
      !sameInode(moved, current)
    ) {
      throw new Error(`Operator recovery journal alias changed during recovery: ${target}`);
    }
    unlinkSync(recoveryAlias);
  } catch (error) {
    if (!pathEntryExists(candidate) && pathEntryExists(recoveryAlias)) {
      renameSync(recoveryAlias, candidate);
    }
    throw error;
  }
}

function readJournalControl(target: string): { raw: string; sha256: string } {
  recoverJournalPublishAlias(target);
  const control = readExclusiveControlText(target, "Operator recovery journal", MAX_JOURNAL_BYTES);
  return { raw: control.text, sha256: control.sha256 };
}

function publishJournalControl(
  target: string,
  raw: string,
  equivalent: (existingRaw: string) => boolean,
): { raw: string; sha256: string } {
  if (pathEntryExists(target)) {
    const existing = readJournalControl(target);
    if (equivalent(existing.raw)) return existing;
    throw new Error(`Operator recovery journal conflicts with existing bytes: ${target}`);
  }
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temp, raw, { encoding: "utf8", flag: "wx" });
    try {
      linkSync(temp, target);
    } catch (error) {
      if (!pathEntryExists(target)) throw error;
      const existing = readJournalControl(target);
      if (equivalent(existing.raw)) return existing;
      throw new Error(`Operator recovery journal raced with foreign bytes: ${target}`, {
        cause: error,
      });
    }
  } finally {
    rmSync(temp, { force: true });
  }
  const committed = readJournalControl(target);
  if (committed.raw !== raw) {
    throw new Error(`Operator recovery journal changed during publish: ${target}`);
  }
  return committed;
}

function validateExpectedReceipt(value: unknown): MissionCompletionReceipt {
  if (!isRecord(value)) throw new Error("Operator recovery expected receipt must be an object");
  assertExactKeys(
    value,
    [
      "completedAt",
      "evidenceVersion",
      "missionId",
      "receiptVersion",
      "runCheckpointSha256",
      "terminalRunId",
    ],
    "Operator recovery expected receipt",
  );
  if (
    value.receiptVersion !== 1 ||
    typeof value.missionId !== "string" ||
    typeof value.terminalRunId !== "string" ||
    typeof value.evidenceVersion !== "string" ||
    typeof value.runCheckpointSha256 !== "string" ||
    !SHA256.test(value.runCheckpointSha256)
  ) {
    throw new Error("Operator recovery expected receipt binding is invalid");
  }
  assertIsoTimestamp(value.completedAt, "Operator recovery expected receipt completedAt");
  return value as unknown as MissionCompletionReceipt;
}

function validateCompletionBinding(value: unknown): RecoveryCompletionBindingV1 {
  if (!isRecord(value)) throw new Error("Operator recovery completion binding must be an object");
  assertExactKeys(
    value,
    [
      "expectedHeadFingerprint",
      "expectedReceipt",
      "intentSha256",
      "missionId",
      "terminalRunId",
    ],
    "Operator recovery completion binding",
  );
  if (
    typeof value.missionId !== "string" ||
    typeof value.terminalRunId !== "string" ||
    typeof value.expectedHeadFingerprint !== "string" ||
    !SHA256.test(value.expectedHeadFingerprint) ||
    typeof value.intentSha256 !== "string" ||
    !SHA256.test(value.intentSha256)
  ) {
    throw new Error("Operator recovery completion binding is invalid");
  }
  const expectedReceipt = validateExpectedReceipt(value.expectedReceipt);
  if (
    expectedReceipt.missionId !== value.missionId ||
    expectedReceipt.terminalRunId !== value.terminalRunId
  ) {
    throw new Error("Operator recovery completion receipt binding is invalid");
  }
  return { ...value, expectedReceipt } as RecoveryCompletionBindingV1;
}

function parseJournalIntent(
  raw: string,
  operationId: string,
  request: ApplyOperatorRecoveryInput,
): OperatorRecoveryJournalIntentV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Operator recovery journal intent is unreadable", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("Operator recovery journal intent must be an object");
  assertExactKeys(
    parsed,
    [
      "action",
      "completionBinding",
      "createdAt",
      "incidentId",
      "journalVersion",
      "operationId",
      "preconditionSha256",
      "reason",
      "recordKind",
    ],
    "Operator recovery journal intent",
  );
  if (
    parsed.journalVersion !== OPERATOR_RECOVERY_JOURNAL_VERSION ||
    parsed.recordKind !== "operator-recovery-intent" ||
    parsed.operationId !== operationId ||
    parsed.incidentId !== request.incidentId ||
    parsed.action !== request.action ||
    parsed.preconditionSha256 !== request.preconditionSha256 ||
    parsed.reason !== request.reason
  ) {
    throw new Error("Operator recovery journal intent conflicts with the requested operation");
  }
  assertIsoTimestamp(parsed.createdAt, "Operator recovery journal intent createdAt");
  const completionBinding = validateCompletionBinding(parsed.completionBinding);
  return { ...parsed, completionBinding } as OperatorRecoveryJournalIntentV1;
}

function validateRecoveryResult(value: unknown): VerifyCompletionRecoveryResult {
  if (!isRecord(value)) throw new Error("Operator recovery result must be an object");
  const allowedKeys = value.reason === undefined
    ? ["recovered", "status"]
    : ["reason", "recovered", "status"];
  assertExactKeys(value, allowedKeys, "Operator recovery result");
  if (!["none", "recovered", "busy", "blocked"].includes(String(value.status))) {
    throw new Error("Operator recovery result status is invalid");
  }
  if (!Array.isArray(value.recovered)) throw new Error("Operator recovery result recovered list is invalid");
  for (const recovered of value.recovered) {
    if (!isRecord(recovered)) throw new Error("Operator recovery recovered entry is invalid");
    assertExactKeys(
      recovered,
      ["missionId", "mode", "terminalRunId"],
      "Operator recovery recovered entry",
    );
    if (
      typeof recovered.missionId !== "string" ||
      typeof recovered.terminalRunId !== "string" ||
      (recovered.mode !== "dequeued_head" && recovered.mode !== "head_already_absent")
    ) {
      throw new Error("Operator recovery recovered binding is invalid");
    }
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new Error("Operator recovery result reason is invalid");
  }
  return value as unknown as VerifyCompletionRecoveryResult;
}

function parseJournalReceipt(
  raw: string,
  operationId: string,
  intentSha256: string,
  binding: RecoveryCompletionBindingV1,
): OperatorRecoveryJournalReceiptV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Operator recovery journal receipt is unreadable", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("Operator recovery journal receipt must be an object");
  assertExactKeys(
    parsed,
    [
      "completedAt",
      "intentSha256",
      "journalVersion",
      "operationId",
      "recordKind",
      "recovery",
    ],
    "Operator recovery journal receipt",
  );
  if (
    parsed.journalVersion !== OPERATOR_RECOVERY_JOURNAL_VERSION ||
    parsed.recordKind !== "operator-recovery-receipt" ||
    parsed.operationId !== operationId ||
    parsed.intentSha256 !== intentSha256
  ) {
    throw new Error("Operator recovery journal receipt binding is invalid");
  }
  assertIsoTimestamp(parsed.completedAt, "Operator recovery journal receipt completedAt");
  const recovery = validateRecoveryResult(parsed.recovery);
  if (recovery.status === "none") {
    throw new Error("Operator recovery journal receipt cannot record an empty exact recovery");
  }
  if (recovery.status === "recovered") {
    if (
      recovery.recovered.length !== 1 ||
      recovery.recovered[0]?.missionId !== binding.missionId ||
      recovery.recovered[0]?.terminalRunId !== binding.terminalRunId
    ) {
      throw new Error("Operator recovery journal receipt recovered the wrong completion binding");
    }
  } else if (recovery.recovered.length !== 0) {
    throw new Error("Operator recovery journal receipt has unexpected partial recovery state");
  }
  return { ...parsed, recovery } as OperatorRecoveryJournalReceiptV1;
}

function operationIdFor(request: ApplyOperatorRecoveryInput): string {
  return sha256(canonicalJson({
    journalVersion: OPERATOR_RECOVERY_JOURNAL_VERSION,
    incidentId: request.incidentId,
    action: request.action,
    preconditionSha256: request.preconditionSha256,
    reason: request.reason,
  }));
}

function sameReceiptEvidence(
  left: MissionCompletionReceipt,
  right: MissionCompletionReceipt,
): boolean {
  return left.receiptVersion === right.receiptVersion &&
    left.missionId === right.missionId &&
    left.terminalRunId === right.terminalRunId &&
    left.runCheckpointSha256 === right.runCheckpointSha256 &&
    left.evidenceVersion === right.evidenceVersion;
}

function proveCompletedRecovery(
  workbench: string,
  binding: RecoveryCompletionBindingV1,
): VerifyCompletionRecoveryResult | null {
  const receipt = readMissionCompletionReceipt(workbench, binding.missionId);
  if (!receipt || !sameReceiptEvidence(receipt, binding.expectedReceipt)) return null;
  const activeIntent = inspectPendingVerifyCompletionIntentFile(
    workbench,
    `${sha256(binding.missionId)}.json`,
  );
  if (activeIntent && activeIntent.sha256 !== binding.intentSha256) {
    throw new Error("Active completion intent conflicts with the operator recovery journal");
  }
  if (activeIntent) {
    const recovery = recoverExactPendingVerifyCompletion(
      workbench,
      binding.missionId,
      binding.intentSha256,
    );
    return recovery.status === "recovered" ? recovery : null;
  }
  return {
    status: "recovered",
    recovered: [{
      missionId: binding.missionId,
      terminalRunId: binding.terminalRunId,
      mode: "head_already_absent",
    }],
  };
}

function resumeChangedJournalOperation(
  workbench: string,
  binding: RecoveryCompletionBindingV1,
): VerifyCompletionRecoveryResult | null {
  const activeIntent = inspectPendingVerifyCompletionIntentFile(
    workbench,
    `${sha256(binding.missionId)}.json`,
  );
  if (activeIntent) {
    if (activeIntent.sha256 !== binding.intentSha256) {
      throw new Error("Active completion intent conflicts with the operator recovery journal");
    }
  }
  // Inventory drift after journaling is resumable only when the domain commit
  // is already proven by its authoritative completion receipt and queue state.
  return proveCompletedRecovery(workbench, binding);
}

function sameCompletionBinding(
  left: RecoveryCompletionBindingV1,
  right: RecoveryCompletionBindingV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateApplyInput(value: ApplyOperatorRecoveryInput): ApplyOperatorRecoveryInput {
  if (!isRecord(value)) throw new Error("Operator recovery input must be an object");
  const keys = Object.keys(value).sort();
  const expected = ["action", "incidentId", "preconditionSha256", "reason"];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error("Operator recovery input has missing or unknown fields");
  }
  if (!SHA256.test(value.incidentId) || !SHA256.test(value.preconditionSha256)) {
    throw new Error("Operator recovery fingerprints must be lowercase SHA-256 values");
  }
  if (value.action !== "resume_exact_intent") {
    throw new Error("Unsupported operator recovery action");
  }
  if (
    typeof value.reason !== "string" ||
    value.reason.length < 1 ||
    value.reason.length > 500 ||
    value.reason !== value.reason.trim() ||
    /[\u0000-\u001f\u007f]/.test(value.reason)
  ) {
    throw new Error("Operator recovery reason must be trimmed, non-empty, and at most 500 characters");
  }
  return value;
}

export function applyOperatorRecovery(
  workbench: string,
  input: ApplyOperatorRecoveryInput,
): ApplyOperatorRecoveryResult {
  const request = validateApplyInput(input);
  const operationId = operationIdFor(request);
  let paths = existingJournalPaths(workbench, operationId);
  if (paths && !pathEntryExists(paths.intent) && pathEntryExists(paths.receipt)) {
    throw new Error("Operator recovery receipt exists without its immutable intent");
  }

  let preparedBinding: RecoveryCompletionBindingV1 | null = null;
  if (!paths || !pathEntryExists(paths.intent)) {
    const inventory = inspectOperatorRecovery(workbench);
    if (inventory.inventorySha256 !== request.preconditionSha256) {
      throw new Error("Operator recovery inventory changed before apply");
    }
    const incident = inventory.incidents.find(
      (candidate) => candidate.incidentId === request.incidentId,
    );
    if (!incident) throw new Error("Operator recovery incident is no longer present");
    if (!incident.allowedActions.includes(request.action) || !incident.completionBinding) {
      throw new Error("Operator recovery action is not allowed for this incident");
    }
    preparedBinding = incident.completionBinding;
    paths ??= createJournalPaths(workbench, operationId);
    if (!pathEntryExists(paths.intent) && pathEntryExists(paths.receipt)) {
      throw new Error("Operator recovery receipt exists without its immutable intent");
    }
  }

  let intentControl: { raw: string; sha256: string };
  let journalIntent: OperatorRecoveryJournalIntentV1;
  if (pathEntryExists(paths.intent)) {
    intentControl = readJournalControl(paths.intent);
    journalIntent = parseJournalIntent(intentControl.raw, operationId, request);
  } else {
    if (!preparedBinding) throw new Error("Operator recovery completion binding is missing");
    const candidate: OperatorRecoveryJournalIntentV1 = {
      journalVersion: OPERATOR_RECOVERY_JOURNAL_VERSION,
      recordKind: "operator-recovery-intent",
      operationId,
      incidentId: request.incidentId,
      action: request.action,
      preconditionSha256: request.preconditionSha256,
      reason: request.reason,
      completionBinding: preparedBinding,
      createdAt: new Date().toISOString(),
    };
    const raw = `${JSON.stringify(candidate, null, 2)}\n`;
    intentControl = publishJournalControl(paths.intent, raw, (existingRaw) => {
      const existing = parseJournalIntent(existingRaw, operationId, request);
      return sameCompletionBinding(existing.completionBinding, candidate.completionBinding);
    });
    journalIntent = parseJournalIntent(intentControl.raw, operationId, request);
    if (!sameCompletionBinding(journalIntent.completionBinding, candidate.completionBinding)) {
      throw new Error("Operator recovery journal intent has a conflicting completion binding");
    }
  }

  if (pathEntryExists(paths.receipt)) {
    const receipt = parseJournalReceipt(
      readJournalControl(paths.receipt).raw,
      operationId,
      intentControl.sha256,
      journalIntent.completionBinding,
    );
    if (receipt.recovery.status === "recovered") {
      const live = proveCompletedRecovery(workbench, journalIntent.completionBinding);
      if (!live) {
        throw new Error("Operator recovery journal receipt is not backed by live completion evidence");
      }
    }
    return {
      operationId,
      incidentId: request.incidentId,
      action: request.action,
      reason: request.reason,
      recovery: receipt.recovery,
    };
  }

  const currentInventory = inspectOperatorRecovery(workbench);
  let recovery: VerifyCompletionRecoveryResult;
  if (currentInventory.inventorySha256 === request.preconditionSha256) {
    const incident = currentInventory.incidents.find(
      (candidate) => candidate.incidentId === request.incidentId,
    );
    if (
      !incident ||
      !incident.allowedActions.includes(request.action) ||
      !incident.completionBinding ||
      !sameCompletionBinding(incident.completionBinding, journalIntent.completionBinding)
    ) {
      throw new Error("Operator recovery incident changed after journal preparation");
    }
    recovery = recoverExactPendingVerifyCompletion(
      workbench,
      journalIntent.completionBinding.missionId,
      journalIntent.completionBinding.intentSha256,
    );
  } else {
    const committed = resumeChangedJournalOperation(workbench, journalIntent.completionBinding);
    if (!committed) {
      throw new Error("Operator recovery inventory changed after journal preparation");
    }
    recovery = committed;
  }

  const receiptCandidate: OperatorRecoveryJournalReceiptV1 = {
    journalVersion: OPERATOR_RECOVERY_JOURNAL_VERSION,
    recordKind: "operator-recovery-receipt",
    operationId,
    intentSha256: intentControl.sha256,
    recovery,
    completedAt: new Date().toISOString(),
  };
  const receiptRaw = `${JSON.stringify(receiptCandidate, null, 2)}\n`;
  const receiptControl = publishJournalControl(paths.receipt, receiptRaw, (existingRaw) => {
    const existing = parseJournalReceipt(
      existingRaw,
      operationId,
      intentControl.sha256,
      journalIntent.completionBinding,
    );
    return canonicalJson(existing.recovery) === canonicalJson(recovery);
  });
  const committedReceipt = parseJournalReceipt(
    receiptControl.raw,
    operationId,
    intentControl.sha256,
    journalIntent.completionBinding,
  );
  return {
    operationId,
    incidentId: request.incidentId,
    action: request.action,
    reason: request.reason,
    recovery: committedReceipt.recovery,
  };
}
