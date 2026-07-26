import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { readExclusiveControlText } from "./control-file.js";
import { nowIso } from "./env.js";
import {
  assertRevisionAttempt,
  assertSafeRevisionParentRunId,
  revisionFixRunId,
} from "./revision-lineage.js";
import type { QueueItem } from "./types.js";
import {
  ensureWorkbenchRootDirectory,
  validateWorkbenchRootDirectory,
  type WorkbenchRootName,
} from "./workbench-paths.js";

const MAX_RUN_MINUTES = 240;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_QUEUE_LOCK_BYTES = 16 * 1024;
const DEFAULT_QUEUE_LOCK_STALE_MS = 30_000;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LEASE_TOKEN = /^[a-f0-9-]{36}$/;
const QUEUE_ITEM_KEYS = [
  "id",
  "horizon",
  "kind",
  "run_kind",
  "repo_target",
  "mission_id",
  "phase_id",
  "prompt",
  "provider",
  "max_minutes",
  "success_criteria",
  "workflow_id",
  "eval_profile",
  "depends_on",
  "model",
  "allowed_tools",
  "experiment_id",
  "experiment_arm",
  "experiment_episode",
  "source_phase_id",
  "experiment_fixture_sha256",
  "experiment_prompt_sha256",
  "revision_of",
  "revision_attempt",
] as const satisfies readonly (keyof QueueItem)[];
const QUEUE_ITEM_KEY_SET = new Set<string>(QUEUE_ITEM_KEYS);
const TOP_LEVEL_KEYS = new Set(["updated", "now", "backlog"]);

export type QueueRevision = string | null;

export interface QueueSnapshot {
  now: QueueItem[];
  backlog: QueueItem[];
  revision: QueueRevision;
  source: "missing" | "file";
}

export interface ConditionalQueueHeadUpdate {
  expectedRevision: QueueRevision;
  expectedHead: QueueItem;
  replacement: QueueItem[];
}

export interface ConditionalQueueSnapshotUpdate {
  expectedRevision: QueueRevision;
  now: QueueItem[];
  backlog: QueueItem[];
}

export interface QueueMutationDependencies {
  afterPreimageMoved?: (context: {
    targetPath: string;
    quarantinePath: string;
  }) => void;
}

export type ConditionalQueueHeadResult =
  | { ok: true; previous: QueueSnapshot; current: QueueSnapshot }
  | { ok: false; reason: "busy" }
  | { ok: false; reason: "revision_conflict"; current: QueueSnapshot }
  | {
      ok: false;
      reason: "head_mismatch";
      current: QueueSnapshot;
      expectedHeadFingerprint: string;
      actualHeadFingerprint: string | null;
    };

export type ConditionalQueueSnapshotResult =
  | { ok: true; previous: QueueSnapshot; current: QueueSnapshot }
  | { ok: false; reason: "busy" }
  | { ok: false; reason: "revision_conflict"; current: QueueSnapshot };

export type ConditionalQueueHeadCommitResult<T> =
  | { ok: true; previous: QueueSnapshot; current: QueueSnapshot; value: T }
  | Exclude<ConditionalQueueHeadResult, { ok: true }>
  | {
      ok: false;
      reason: "commit_failed";
      error: unknown;
      rollbackError?: unknown;
      restored: boolean;
      previous: QueueSnapshot;
      current: QueueSnapshot;
    };

export type RecoverQueueHeadCommitResult<T> =
  | {
      ok: true;
      mode: "dequeued_head" | "head_already_absent";
      previous: QueueSnapshot;
      current: QueueSnapshot;
      value: T;
    }
  | { ok: false; reason: "busy" }
  | { ok: false; reason: "conflict"; current: QueueSnapshot }
  | {
      ok: false;
      reason: "commit_failed";
      error: unknown;
      rollbackError?: unknown;
      restored: boolean;
      previous: QueueSnapshot;
      current: QueueSnapshot;
    };

type QueueCommitAttemptResult<T> =
  | { ok: true; previous: QueueSnapshot; current: QueueSnapshot; value: T }
  | Extract<ConditionalQueueHeadCommitResult<T>, { reason: "commit_failed" }>;

interface QueueLeaseState {
  token: string;
  pid: number;
  acquiredAt: number;
}

interface QueueLease extends QueueLeaseState {
  lockPath: string;
}

interface LockSnapshot {
  raw: string;
  state: QueueLeaseState | null;
  kind: "file" | "symlink" | "other";
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

interface QueueControlSnapshot {
  raw: string;
  sha256: string;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

interface QueueReadSnapshot {
  queue: QueueSnapshot;
  control: QueueControlSnapshot | null;
}

export class QueueFileError extends Error {
  readonly code = "INVALID_QUEUE";

  constructor(
    readonly queuePath: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid queue file ${queuePath}: ${reason}`, options);
    this.name = "QueueFileError";
  }
}

export class QueueMutationBusyError extends Error {
  readonly code = "QUEUE_MUTATION_BUSY";

  constructor(readonly lockPath: string) {
    super(`Queue mutation lease is busy: ${lockPath}`);
    this.name = "QueueMutationBusyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function yamlQuote(value: string | number | undefined): string {
  if (value == null || value === "") return '""';
  const stringValue = String(value);
  if (/^[a-zA-Z0-9_./+-]+$/.test(stringValue)) return stringValue;
  return JSON.stringify(stringValue);
}

function requireString(
  value: unknown,
  label: string,
  queuePath: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
    throw new QueueFileError(queuePath, `${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: keyof QueueItem,
  label: string,
  queuePath: string,
): string | undefined {
  if (!(key in source)) return undefined;
  return requireString(source[key], label, queuePath);
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  queuePath: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new QueueFileError(queuePath, `${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function normalizeQueueItem(value: unknown, label: string, queuePath: string): QueueItem {
  if (!isRecord(value)) {
    throw new QueueFileError(queuePath, `${label} must be a mapping`);
  }
  const unknownKeys = Object.keys(value).filter((key) => !QUEUE_ITEM_KEY_SET.has(key));
  if (unknownKeys.length > 0) {
    throw new QueueFileError(queuePath, `${label} has unknown fields: ${unknownKeys.join(", ")}`);
  }

  const id = requireString(value.id, `${label}.id`, queuePath);
  if (!RUN_ID.test(id)) {
    throw new QueueFileError(queuePath, `${label}.id is not a safe run id: ${id}`);
  }
  const horizon =
    value.horizon === undefined
      ? "day"
      : requireEnum(value.horizon, ["day", "mission"] as const, `${label}.horizon`, queuePath);
  const kind =
    value.kind === undefined ? "task" : requireString(value.kind, `${label}.kind`, queuePath);
  const prompt =
    value.prompt === undefined
      ? "executor_generic"
      : requireString(value.prompt, `${label}.prompt`, queuePath);

  const item: QueueItem = { id, horizon, kind, prompt };
  if (value.run_kind !== undefined) {
    item.run_kind = requireEnum(
      value.run_kind,
      ["implement", "review", "verify", "debate", "vote"] as const,
      `${label}.run_kind`,
      queuePath,
    );
  }
  if (value.repo_target !== undefined) {
    item.repo_target = requireEnum(
      value.repo_target,
      ["workbench", "juno-overseer"] as const,
      `${label}.repo_target`,
      queuePath,
    );
  }
  if (value.provider !== undefined) {
    item.provider = requireEnum(
      value.provider,
      ["api_token", "cursor_composer", "openai_codex"] as const,
      `${label}.provider`,
      queuePath,
    );
  }
  if (value.eval_profile !== undefined) {
    item.eval_profile = requireEnum(
      value.eval_profile,
      ["code", "ui", "literature", "orchestrator"] as const,
      `${label}.eval_profile`,
      queuePath,
    );
  }
  if (value.max_minutes !== undefined) {
    if (
      !Number.isSafeInteger(value.max_minutes) ||
      (value.max_minutes as number) < 1 ||
      (value.max_minutes as number) > MAX_RUN_MINUTES
    ) {
      throw new QueueFileError(
        queuePath,
        `${label}.max_minutes must be an integer between 1 and ${MAX_RUN_MINUTES}`,
      );
    }
    item.max_minutes = value.max_minutes as number;
  }

  item.mission_id = optionalString(value, "mission_id", `${label}.mission_id`, queuePath);
  item.phase_id = optionalString(value, "phase_id", `${label}.phase_id`, queuePath);
  item.success_criteria = optionalString(
    value,
    "success_criteria",
    `${label}.success_criteria`,
    queuePath,
  );
  item.workflow_id = optionalString(value, "workflow_id", `${label}.workflow_id`, queuePath);
  item.depends_on = optionalString(value, "depends_on", `${label}.depends_on`, queuePath);
  item.model = optionalString(value, "model", `${label}.model`, queuePath);
  item.experiment_id = optionalString(
    value,
    "experiment_id",
    `${label}.experiment_id`,
    queuePath,
  );
  item.source_phase_id = optionalString(
    value,
    "source_phase_id",
    `${label}.source_phase_id`,
    queuePath,
  );
  item.experiment_fixture_sha256 = optionalString(
    value,
    "experiment_fixture_sha256",
    `${label}.experiment_fixture_sha256`,
    queuePath,
  );
  item.experiment_prompt_sha256 = optionalString(
    value,
    "experiment_prompt_sha256",
    `${label}.experiment_prompt_sha256`,
    queuePath,
  );
  item.revision_of = optionalString(value, "revision_of", `${label}.revision_of`, queuePath);
  if (item.revision_of !== undefined) {
    try {
      assertSafeRevisionParentRunId(item.revision_of);
    } catch (error) {
      throw new QueueFileError(queuePath, `${label}.revision_of must be a safe run id`, {
        cause: error,
      });
    }
  }
  if (value.revision_attempt !== undefined) {
    try {
      assertRevisionAttempt(value.revision_attempt);
      item.revision_attempt = value.revision_attempt;
    } catch (error) {
      throw new QueueFileError(
        queuePath,
        `${label}.revision_attempt must be a bounded positive integer`,
        { cause: error },
      );
    }
  }
  if ((item.revision_of === undefined) !== (item.revision_attempt === undefined)) {
    throw new QueueFileError(
      queuePath,
      `${label}.revision_of and ${label}.revision_attempt must be provided together`,
    );
  }
  if (item.revision_of !== undefined && item.revision_attempt !== undefined) {
    if (item.run_kind !== "implement") {
      throw new QueueFileError(queuePath, `${label} revision lineage requires run_kind=implement`);
    }
    if (item.id !== revisionFixRunId(item.revision_of, item.revision_attempt)) {
      throw new QueueFileError(queuePath, `${label}.id does not match its revision lineage`);
    }
  }
  if (
    item.experiment_fixture_sha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(item.experiment_fixture_sha256)
  ) {
    throw new QueueFileError(
      queuePath,
      `${label}.experiment_fixture_sha256 must be SHA-256`,
    );
  }
  if (
    item.experiment_prompt_sha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(item.experiment_prompt_sha256)
  ) {
    throw new QueueFileError(
      queuePath,
      `${label}.experiment_prompt_sha256 must be SHA-256`,
    );
  }
  if (value.experiment_arm !== undefined) {
    item.experiment_arm = requireEnum(
      value.experiment_arm,
      ["baseline", "candidate"] as const,
      `${label}.experiment_arm`,
      queuePath,
    );
  }
  if (value.experiment_episode !== undefined) {
    if (
      !Number.isSafeInteger(value.experiment_episode) ||
      (value.experiment_episode as number) < 1 ||
      (value.experiment_episode as number) > 99
    ) {
      throw new QueueFileError(
        queuePath,
        `${label}.experiment_episode must be an integer between 1 and 99`,
      );
    }
    item.experiment_episode = value.experiment_episode as number;
  }

  const experimentFields = [
    item.experiment_id,
    item.experiment_arm,
    item.experiment_episode,
    item.source_phase_id,
    item.experiment_fixture_sha256,
    item.experiment_prompt_sha256,
  ];
  if (experimentFields.some((entry) => entry !== undefined)) {
    if (
      experimentFields.some((entry) => entry === undefined) ||
      !item.workflow_id ||
      !item.mission_id ||
      !item.phase_id ||
      !item.run_kind ||
      !item.eval_profile ||
      item.repo_target !== "workbench" ||
      item.provider !== "openai_codex"
    ) {
      throw new QueueFileError(
        queuePath,
        `${label} experiment metadata requires complete bindings, explicit run_kind/eval_profile, repo_target=workbench, and provider=openai_codex`,
      );
    }
  }

  if (value.allowed_tools !== undefined) {
    if (
      !Array.isArray(value.allowed_tools) ||
      value.allowed_tools.some((entry) => typeof entry !== "string" || entry.length === 0)
    ) {
      throw new QueueFileError(
        queuePath,
        `${label}.allowed_tools must contain non-empty strings`,
      );
    }
    if (new Set(value.allowed_tools).size !== value.allowed_tools.length) {
      throw new QueueFileError(queuePath, `${label}.allowed_tools contains duplicates`);
    }
    if (value.allowed_tools.length > 0) item.allowed_tools = [...value.allowed_tools];
  }

  for (const key of QUEUE_ITEM_KEYS) {
    if (item[key] === undefined) delete item[key];
  }
  return item;
}

function normalizeSection(value: unknown, label: string, queuePath: string): QueueItem[] {
  // Legacy queue writers emitted a bare `now:` or `backlog:` for an empty section.
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new QueueFileError(queuePath, `${label} must be a sequence`);
  }
  return value.map((item, index) => normalizeQueueItem(item, `${label}[${index}]`, queuePath));
}

function validateQueueCollections(
  now: unknown,
  backlog: unknown,
  queuePath: string,
): { now: QueueItem[]; backlog: QueueItem[] } {
  const normalizedNow = normalizeSection(now, "now", queuePath);
  const normalizedBacklog = normalizeSection(backlog, "backlog", queuePath);
  const seen = new Set<string>();
  for (const item of [...normalizedNow, ...normalizedBacklog]) {
    if (seen.has(item.id)) {
      throw new QueueFileError(queuePath, `duplicate queue item id: ${item.id}`);
    }
    seen.add(item.id);
  }
  return { now: normalizedNow, backlog: normalizedBacklog };
}

function parseQueueText(text: string, queuePath: string): { now: QueueItem[]; backlog: QueueItem[] } {
  let document;
  try {
    document = parseDocument(text, { prettyErrors: false, strict: true, uniqueKeys: true });
  } catch (error) {
    throw new QueueFileError(queuePath, "YAML parsing failed", { cause: error });
  }
  if (document.errors.length > 0) {
    throw new QueueFileError(
      queuePath,
      `YAML parsing failed: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  if (document.warnings.length > 0) {
    throw new QueueFileError(
      queuePath,
      `YAML warnings are not allowed: ${document.warnings
        .map((warning) => warning.message)
        .join("; ")}`,
    );
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch (error) {
    throw new QueueFileError(queuePath, "YAML aliases are not allowed", { cause: error });
  }
  if (!isRecord(value)) {
    throw new QueueFileError(queuePath, "root must be a mapping");
  }
  const unknownKeys = Object.keys(value).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new QueueFileError(queuePath, `unknown top-level fields: ${unknownKeys.join(", ")}`);
  }
  if (!("now" in value) || !("backlog" in value)) {
    throw new QueueFileError(queuePath, "root must contain now and backlog sections");
  }
  if (value.updated !== undefined && typeof value.updated !== "string") {
    throw new QueueFileError(queuePath, "updated must be a string when present");
  }
  return validateQueueCollections(value.now, value.backlog, queuePath);
}

export function parseQueueDocument(
  text: string,
  sourceLabel = "<queue-candidate>",
): { now: QueueItem[]; backlog: QueueItem[] } {
  return parseQueueText(text, sourceLabel);
}

function canonicalQueueItem(item: QueueItem): Record<string, unknown> {
  const normalized = normalizeQueueItem(item, "queue item", "<queue-item>");
  const canonical: Record<string, unknown> = {};
  for (const key of QUEUE_ITEM_KEYS) {
    const value = normalized[key];
    if (value !== undefined) canonical[key] = Array.isArray(value) ? [...value] : value;
  }
  return canonical;
}

export function queueItemFingerprint(item: QueueItem): string {
  return hashText(JSON.stringify(canonicalQueueItem(item)));
}

function formatQueueItem(item: QueueItem): string {
  const lines = [`  - id: ${yamlQuote(item.id)}`];
  const fields: Array<[keyof QueueItem, string]> = [
    ["horizon", "horizon"],
    ["kind", "kind"],
    ["run_kind", "run_kind"],
    ["repo_target", "repo_target"],
    ["mission_id", "mission_id"],
    ["phase_id", "phase_id"],
    ["prompt", "prompt"],
    ["provider", "provider"],
    ["success_criteria", "success_criteria"],
    ["workflow_id", "workflow_id"],
    ["eval_profile", "eval_profile"],
    ["depends_on", "depends_on"],
    ["model", "model"],
    ["experiment_id", "experiment_id"],
    ["experiment_arm", "experiment_arm"],
    ["source_phase_id", "source_phase_id"],
    ["experiment_fixture_sha256", "experiment_fixture_sha256"],
    ["experiment_prompt_sha256", "experiment_prompt_sha256"],
    ["revision_of", "revision_of"],
  ];
  for (const [key, label] of fields) {
    const value = item[key];
    if (value == null || value === "") continue;
    lines.push(`    ${label}: ${yamlQuote(String(value))}`);
  }
  if (item.max_minutes != null) lines.push(`    max_minutes: ${item.max_minutes}`);
  if (item.experiment_episode != null) {
    lines.push(`    experiment_episode: ${item.experiment_episode}`);
  }
  if (item.revision_attempt != null) {
    lines.push(`    revision_attempt: ${item.revision_attempt}`);
  }
  if (item.allowed_tools?.length) {
    lines.push(`    allowed_tools: ${JSON.stringify(item.allowed_tools)}`);
  }
  return lines.join("\n");
}

function renderQueue(now: QueueItem[], backlog: QueueItem[]): string {
  const lines = [`updated: ${nowIso()}`, "now:"];
  if (now.length === 0) lines.push("  []");
  else for (const item of now) lines.push(formatQueueItem(item));
  lines.push("backlog:");
  if (backlog.length === 0) lines.push("  []");
  else for (const item of backlog) lines.push(formatQueueItem(item));
  return `${lines.join("\n")}\n`;
}

function existingWorkbenchRoot(
  workbench: string,
  rootName: WorkbenchRootName,
): string | null {
  const lexicalRoot = path.join(path.resolve(workbench), rootName);
  try {
    lstatSync(lexicalRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return validateWorkbenchRootDirectory(workbench, rootName);
}

function queuePathFor(workbench: string, createRoot: true): string;
function queuePathFor(workbench: string, createRoot?: false): string | null;
function queuePathFor(workbench: string, createRoot = false): string | null {
  const queueRoot = createRoot
    ? ensureWorkbenchRootDirectory(workbench, "queue")
    : existingWorkbenchRoot(workbench, "queue");
  return queueRoot ? path.join(queueRoot, "now.yaml") : null;
}

export function queueMutationLockPath(workbench: string): string {
  const stateRoot = existingWorkbenchRoot(workbench, "state") ??
    path.join(path.resolve(workbench), "state");
  return path.join(stateRoot, "queue-mutation.lock.json");
}

function queueLeaseLockPath(workbench: string): string {
  return path.join(
    ensureWorkbenchRootDirectory(workbench, "state"),
    "queue-mutation.lock.json",
  );
}

function recoveryGuardPath(lockPath: string): string {
  return `${lockPath}.recovery`;
}

function parseLeaseState(raw: string): QueueLeaseState | null {
  try {
    const value = JSON.parse(raw) as Partial<QueueLeaseState>;
    return typeof value.token === "string" &&
      LEASE_TOKEN.test(value.token) &&
      Number.isSafeInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      Number.isFinite(value.acquiredAt)
      ? (value as QueueLeaseState)
      : null;
  } catch {
    return null;
  }
}

function sameFileStat(left: Stats, right: Stats): boolean {
  return (
    (process.platform === "win32" || left.dev === right.dev) &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function readQueueControlSnapshot(target: string): QueueControlSnapshot | null {
  let before: Stats;
  try {
    before = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const control = readExclusiveControlText(target, "Queue file", MAX_QUEUE_BYTES);
  const after = lstatSync(target);
  if (!sameFileStat(before, after) || after.size !== control.byteLength) {
    throw new Error(`Queue file changed while reading: ${target}`);
  }
  return {
    raw: control.text,
    sha256: control.sha256,
    dev: after.dev,
    ino: after.ino,
    mode: after.mode,
    nlink: after.nlink,
    size: after.size,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
    birthtimeMs: after.birthtimeMs,
  };
}

function sameQueueControlSnapshot(
  left: QueueControlSnapshot,
  right: QueueControlSnapshot,
): boolean {
  return left.raw === right.raw &&
    left.sha256 === right.sha256 &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.birthtimeMs === right.birthtimeMs;
}

function assertNoQueuePreimage(queueRoot: string): void {
  const preimages = readdirSync(queueRoot)
    .filter((name) => name.startsWith("now.yaml.preimage-"))
    .sort();
  if (preimages.length > 0) {
    throw new Error(`Queue has orphaned preimage state: ${preimages.join(", ")}`);
  }
}

function readLockSnapshot(target: string): LockSnapshot | null {
  let before: Stats;
  try {
    before = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const { text: raw } = readExclusiveControlText(
    target,
    "Queue mutation lease",
    MAX_QUEUE_LOCK_BYTES,
  );
  const after = lstatSync(target);
  if (!sameFileStat(before, after)) {
    throw new Error(`Queue mutation lease changed while reading: ${target}`);
  }
  return {
    raw,
    state: parseLeaseState(raw),
    kind: "file",
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    mtimeMs: after.mtimeMs,
    birthtimeMs: after.birthtimeMs,
  };
}

function sameLockSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return (
    left.kind === right.kind &&
    left.raw === right.raw &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockIsStale(snapshot: LockSnapshot, staleMs: number): boolean {
  if (snapshot.kind !== "file") return false;
  const acquiredAt = snapshot.state?.acquiredAt ?? snapshot.mtimeMs;
  if (Date.now() - Math.max(acquiredAt, snapshot.mtimeMs) <= staleMs) return false;
  return !snapshot.state || !processIsAlive(snapshot.state.pid);
}

function createLockExclusive(target: string): QueueLease | null {
  const state = { token: randomUUID(), pid: process.pid, acquiredAt: Date.now() };
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(target, "wx");
    created = true;
    writeFileSync(descriptor, `${JSON.stringify(state)}\n`, "utf8");
    return { lockPath: target, ...state };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    if (created) rmSync(target, { force: true });
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function removeLockSnapshot(target: string, expected: LockSnapshot): boolean {
  const current = readLockSnapshot(target);
  if (!current || !sameLockSnapshot(current, expected)) return false;
  const quarantine = `${target}.released-${process.pid}-${randomUUID()}`;
  try {
    renameSync(target, quarantine);
    const moved = readLockSnapshot(quarantine);
    if (!moved || !sameLockSnapshot(moved, expected)) {
      if (!readLockSnapshot(target)) renameSync(quarantine, target);
      return false;
    }
    rmSync(quarantine, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function recoverStaleLock(target: string, staleMs: number): boolean {
  const snapshot = readLockSnapshot(target);
  if (!snapshot) return true;
  if (!lockIsStale(snapshot, staleMs)) return false;
  return removeLockSnapshot(target, snapshot);
}

function acquireRecoveryGuard(lockPath: string, staleMs: number): QueueLease | null {
  const target = recoveryGuardPath(lockPath);
  return createLockExclusive(target) ?? (recoverStaleLock(target, staleMs) ? createLockExclusive(target) : null);
}

function releaseQueueLease(lease: QueueLease): boolean {
  const snapshot = readLockSnapshot(lease.lockPath);
  if (
    !snapshot?.state ||
    snapshot.state.token !== lease.token ||
    snapshot.state.pid !== lease.pid
  ) {
    return false;
  }
  return removeLockSnapshot(lease.lockPath, snapshot);
}

function acquireQueueLease(
  workbench: string,
  staleMs = DEFAULT_QUEUE_LOCK_STALE_MS,
): QueueLease | null {
  const target = queueLeaseLockPath(workbench);
  const immediate = createLockExclusive(target);
  if (immediate) return immediate;

  const guard = acquireRecoveryGuard(target, staleMs);
  if (!guard) return null;
  let acquired: QueueLease | null = null;
  try {
    if (!recoverStaleLock(target, staleMs)) return null;
    acquired = createLockExclusive(target);
    return acquired;
  } finally {
    if (!releaseQueueLease(guard)) {
      if (acquired) releaseQueueLease(acquired);
      throw new Error(`Lost queue lease recovery guard ownership: ${guard.lockPath}`);
    }
  }
}

function withQueueLease<T>(lease: QueueLease, operation: () => T): T {
  let failed = false;
  let failure: unknown;
  let value!: T;
  try {
    value = operation();
  } catch (error) {
    failed = true;
    failure = error;
  }
  let releaseFailure: unknown;
  try {
    if (!releaseQueueLease(lease)) {
      releaseFailure = new Error(`Lost queue mutation lease ownership: ${lease.lockPath}`);
    }
  } catch (error) {
    releaseFailure = error;
  }
  if (failed && releaseFailure) {
    throw new AggregateError([failure, releaseFailure], "Queue mutation and lease release failed");
  }
  if (failed) throw failure;
  if (releaseFailure) throw releaseFailure;
  return value;
}

function missingQueueSnapshot(): QueueReadSnapshot {
  return {
    queue: { now: [], backlog: [], revision: null, source: "missing" },
    control: null,
  };
}

function readQueueSnapshotInternal(workbench: string): QueueReadSnapshot {
  const queuePath = queuePathFor(workbench);
  if (!queuePath) return missingQueueSnapshot();
  assertNoQueuePreimage(path.dirname(queuePath));
  const control = readQueueControlSnapshot(queuePath);
  if (!control) return missingQueueSnapshot();
  const parsed = parseQueueText(control.raw, queuePath);
  return {
    queue: { ...parsed, revision: control.sha256, source: "file" },
    control,
  };
}

function sameExpectedQueue(observed: QueueSnapshot, expected: QueueSnapshot): boolean {
  return observed.source === expected.source && observed.revision === expected.revision;
}

function writeQueueUnlocked(
  workbench: string,
  now: QueueItem[],
  backlog: QueueItem[],
  expected: QueueSnapshot,
  dependencies: QueueMutationDependencies = {},
): QueueSnapshot {
  const queueLabelPath = path.join(path.resolve(workbench), "queue", "now.yaml");
  const normalized = validateQueueCollections(now, backlog, queueLabelPath);
  const text = renderQueue(normalized.now, normalized.backlog);
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > MAX_QUEUE_BYTES) {
    throw new QueueFileError(
      queueLabelPath,
      `rendered queue exceeds the ${MAX_QUEUE_BYTES}-byte limit`,
    );
  }
  const observed = readQueueSnapshotInternal(workbench);
  if (!sameExpectedQueue(observed.queue, expected)) {
    throw new Error("Queue changed concurrently before commit");
  }
  const queuePath = queuePathFor(workbench, true);
  const queueDir = path.dirname(queuePath);
  const tempPath = path.join(queueDir, `.now.yaml.${process.pid}.${randomUUID()}.tmp`);
  const nextRevision = hashText(text);
  let quarantine: string | null = null;
  let preimageVerified = false;
  let installed = false;
  try {
    writeFileSync(tempPath, text, { encoding: "utf8", flag: "wx" });
    validateWorkbenchRootDirectory(workbench, "queue");
    if (observed.control) {
      const current = readQueueControlSnapshot(queuePath);
      if (!current || !sameQueueControlSnapshot(observed.control, current)) {
        throw new Error("Queue changed concurrently before preimage quarantine");
      }
      quarantine = `${queuePath}.preimage-${process.pid}-${randomUUID()}`;
      renameSync(queuePath, quarantine);
      const moved = readQueueControlSnapshot(quarantine);
      if (!moved || !sameQueueControlSnapshot(observed.control, moved)) {
        throw new Error("Queue preimage changed during commit");
      }
      preimageVerified = true;
      dependencies.afterPreimageMoved?.({
        targetPath: queuePath,
        quarantinePath: quarantine,
      });
    } else if (readQueueControlSnapshot(queuePath)) {
      throw new Error("Concurrent queue writer appeared before create");
    }

    validateWorkbenchRootDirectory(workbench, "queue");
    try {
      linkSync(tempPath, queuePath);
      installed = true;
      rmSync(tempPath, { force: true });
    } catch (error) {
      throw new Error("Concurrent queue writer won the commit", { cause: error });
    }
    const committed = readQueueControlSnapshot(queuePath);
    if (!committed || committed.raw !== text || committed.sha256 !== nextRevision) {
      throw new Error("Queue changed during commit verification");
    }
    if (quarantine) {
      rmSync(quarantine, { force: true });
      quarantine = null;
    }
  } catch (error) {
    if (quarantine && preimageVerified && !installed) {
      try {
        validateWorkbenchRootDirectory(workbench, "queue");
        const current = readQueueControlSnapshot(queuePath);
        if (!current) {
          linkSync(quarantine, queuePath);
          rmSync(quarantine, { force: true });
          quarantine = null;
          const restored = readQueueControlSnapshot(queuePath);
          if (
            !restored ||
            !observed.control ||
            !sameQueueControlSnapshot(observed.control, restored)
          ) {
            throw new Error("Restored queue does not match its exact preimage");
          }
        }
      } catch (recoveryError) {
        throw new Error("Queue preimage recovery failed", {
          cause: new AggregateError([error, recoveryError]),
        });
      }
    }
    throw error;
  } finally {
    rmSync(tempPath, { force: true });
  }
  return {
    ...normalized,
    revision: nextRevision,
    source: "file",
  };
}

export function readNowQueueSnapshot(workbench: string): QueueSnapshot {
  return readQueueSnapshotInternal(workbench).queue;
}

export function saveNowQueue(
  workbench: string,
  now: QueueItem[],
  backlog: QueueItem[] = [],
): void {
  const lease = acquireQueueLease(workbench);
  if (!lease) throw new QueueMutationBusyError(queueMutationLockPath(workbench));
  withQueueLease(lease, () => {
    const current = readNowQueueSnapshot(workbench);
    writeQueueUnlocked(workbench, now, backlog, current);
  });
}

export function replaceQueueHeadConditional(
  workbench: string,
  update: ConditionalQueueHeadUpdate,
): ConditionalQueueHeadResult {
  const lease = acquireQueueLease(workbench);
  if (!lease) return { ok: false, reason: "busy" };
  return withQueueLease(lease, () => {
    const current = readNowQueueSnapshot(workbench);
    if (current.revision !== update.expectedRevision) {
      return { ok: false, reason: "revision_conflict", current };
    }

    const expectedHeadFingerprint = queueItemFingerprint(update.expectedHead);
    const actualHeadFingerprint = current.now[0] ? queueItemFingerprint(current.now[0]) : null;
    if (actualHeadFingerprint !== expectedHeadFingerprint) {
      return {
        ok: false,
        reason: "head_mismatch",
        current,
        expectedHeadFingerprint,
        actualHeadFingerprint,
      };
    }

    const nextNow = [...update.replacement, ...current.now.slice(1)];
    const next = writeQueueUnlocked(workbench, nextNow, current.backlog, current);
    return { ok: true, previous: current, current: next };
  });
}

function commitQueueTransitionUnlocked<T>(
  workbench: string,
  previous: QueueSnapshot,
  nextNow: QueueItem[],
  commit: (current: QueueSnapshot) => T,
  dependencies: QueueMutationDependencies = {},
): QueueCommitAttemptResult<T> {
  const committedQueue = writeQueueUnlocked(
    workbench,
    nextNow,
    previous.backlog,
    previous,
    dependencies,
  );
  try {
    const value = commit(committedQueue);
    return { ok: true, previous, current: committedQueue, value };
  } catch (error) {
    const observed = readNowQueueSnapshot(workbench);
    if (observed.revision !== committedQueue.revision) {
      return {
        ok: false,
        reason: "commit_failed",
        error,
        restored: false,
        previous,
        current: observed,
      };
    }
    try {
      const restored = writeQueueUnlocked(
        workbench,
        previous.now,
        previous.backlog,
        observed,
        dependencies,
      );
      return {
        ok: false,
        reason: "commit_failed",
        error,
        restored: true,
        previous,
        current: restored,
      };
    } catch (rollbackError) {
      return {
        ok: false,
        reason: "commit_failed",
        error,
        rollbackError,
        restored: false,
        previous,
        current: readNowQueueSnapshot(workbench),
      };
    }
  }
}

/**
 * Remove the exact queue head and run a durable commit while retaining the queue lease.
 * A failed commit restores only when the exact post-mutation revision is still present.
 */
export function replaceQueueHeadConditionalWithCommit<T>(
  workbench: string,
  update: ConditionalQueueHeadUpdate,
  commit: (current: QueueSnapshot) => T,
  dependencies: QueueMutationDependencies = {},
): ConditionalQueueHeadCommitResult<T> {
  const lease = acquireQueueLease(workbench);
  if (!lease) return { ok: false, reason: "busy" };
  return withQueueLease(lease, () => {
    const current = readNowQueueSnapshot(workbench);
    if (current.revision !== update.expectedRevision) {
      return { ok: false, reason: "revision_conflict", current };
    }

    const expectedHeadFingerprint = queueItemFingerprint(update.expectedHead);
    const actualHeadFingerprint = current.now[0] ? queueItemFingerprint(current.now[0]) : null;
    if (actualHeadFingerprint !== expectedHeadFingerprint) {
      return {
        ok: false,
        reason: "head_mismatch",
        current,
        expectedHeadFingerprint,
        actualHeadFingerprint,
      };
    }

    const nextNow = [...update.replacement, ...current.now.slice(1)];
    return commitQueueTransitionUnlocked(
      workbench,
      current,
      nextNow,
      commit,
      dependencies,
    );
  });
}

/**
 * Reconcile a prepared head-removal after process death. Unrelated queue work is preserved:
 * an exact head is dequeued, while an already absent head commits against the live queue.
 * If that latter commit fails, the lost head is prepended without replacing foreign items.
 */
export function recoverQueueHeadCommit<T>(
  workbench: string,
  expectedHead: QueueItem,
  commit: (current: QueueSnapshot) => T,
): RecoverQueueHeadCommitResult<T> {
  const lease = acquireQueueLease(workbench);
  if (!lease) return { ok: false, reason: "busy" };
  return withQueueLease(lease, () => {
    const current = readNowQueueSnapshot(workbench);
    if (current.source === "missing") {
      return { ok: false, reason: "conflict", current };
    }
    const expectedFingerprint = queueItemFingerprint(expectedHead);
    const headFingerprint = current.now[0] ? queueItemFingerprint(current.now[0]) : null;
    if (headFingerprint === expectedFingerprint) {
      const result = commitQueueTransitionUnlocked(
        workbench,
        current,
        current.now.slice(1),
        commit,
      );
      return result.ok ? { ...result, mode: "dequeued_head" as const } : result;
    }

    const allItems = [...current.now, ...current.backlog];
    const expectedMissionId = expectedHead.mission_id;
    const hasConflictingBinding = allItems.some(
      (item) =>
        item.id === expectedHead.id ||
        queueItemFingerprint(item) === expectedFingerprint ||
        (expectedMissionId !== undefined && item.mission_id === expectedMissionId),
    );
    if (hasConflictingBinding) return { ok: false, reason: "conflict", current };

    try {
      const value = commit(current);
      return {
        ok: true,
        mode: "head_already_absent",
        previous: current,
        current,
        value,
      };
    } catch (error) {
      const observed = readNowQueueSnapshot(workbench);
      if (observed.revision !== current.revision) {
        return {
          ok: false,
          reason: "commit_failed",
          error,
          restored: false,
          previous: current,
          current: observed,
        };
      }
      try {
        const restored = writeQueueUnlocked(
          workbench,
          [expectedHead, ...current.now],
          current.backlog,
          observed,
        );
        return {
          ok: false,
          reason: "commit_failed",
          error,
          restored: true,
          previous: current,
          current: restored,
        };
      } catch (rollbackError) {
        return {
          ok: false,
          reason: "commit_failed",
          error,
          rollbackError,
          restored: false,
          previous: current,
          current: readNowQueueSnapshot(workbench),
        };
      }
    }
  });
}

export function replaceQueueSnapshotConditional(
  workbench: string,
  update: ConditionalQueueSnapshotUpdate,
): ConditionalQueueSnapshotResult {
  const lease = acquireQueueLease(workbench);
  if (!lease) return { ok: false, reason: "busy" };
  return withQueueLease(lease, () => {
    const current = readNowQueueSnapshot(workbench);
    if (current.revision !== update.expectedRevision) {
      return { ok: false, reason: "revision_conflict", current };
    }
    const next = writeQueueUnlocked(
      workbench,
      update.now,
      update.backlog,
      current,
    );
    return { ok: true, previous: current, current: next };
  });
}

export function parseNowYaml(workbench: string): { now: QueueItem[]; backlog: QueueItem[] } {
  const { now, backlog } = readNowQueueSnapshot(workbench);
  return { now, backlog };
}
