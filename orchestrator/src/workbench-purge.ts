/**
 * Safe purge of Juno-generated ephemeral artifacts under AgentWorkbench ONLY.
 * Never touches missions, config, queue, state (except read), repo, Vault, or OS paths.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";

/** Top-level Workbench dirs that purge may touch (never delete the dir itself). */
export const PURGE_ALLOWED_TOP = new Set(["runs", "staging"]);

/** Never delete these top-level dirs or anything inside them. */
export const PURGE_FORBIDDEN_TOP = new Set([
  "missions",
  "config",
  "queue",
  "state",
  "prompts",
  "providers",
  "daily",
  ".cursor",
]);

export interface PurgePolicy {
  /** Keep runs newer than this many days (default 7). */
  runsRetentionDays: number;
  /** Always keep the N most recent run dirs per status (default 20). */
  runsKeepRecent: number;
  /** Delete staging files older than this many days (default 14). */
  stagingRetentionDays: number;
  /** Delete empty run dirs immediately (default true). */
  purgeEmptyRuns: boolean;
}

export const DEFAULT_PURGE_POLICY: PurgePolicy = {
  runsRetentionDays: 7,
  runsKeepRecent: 20,
  stagingRetentionDays: 14,
  purgeEmptyRuns: true,
};

export interface PurgeCandidate {
  relativePath: string;
  reason: string;
  bytes: number;
  category: "run_terminal" | "run_empty" | "staging_stale" | "state_backup";
}

export interface PurgePlan {
  workbenchRoot: string;
  scannedAt: string;
  policy: PurgePolicy;
  protectedNote: string;
  candidates: PurgeCandidate[];
  totalBytes: number;
  activeRunId: string | null;
}

export interface PurgeResult {
  executedAt: string;
  dryRun: boolean;
  deleted: string[];
  skipped: string[];
  errors: { path: string; error: string }[];
  bytesFreed: number;
}

function resolveWorkbenchRoot(workbench: string): string {
  const root = path.resolve(workbench);
  if (!existsSync(root)) {
    throw new Error(`Workbench root does not exist: ${root}`);
  }
  return root;
}

/** True if resolved target is strictly inside workbench and under an allowed top-level dir. */
export function isSafePurgePath(workbenchRoot: string, target: string): boolean {
  const root = path.resolve(workbenchRoot);
  const resolved = path.resolve(target);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return false;
  }
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return false;
  }
  const top = rel.split(path.sep)[0];
  if (PURGE_FORBIDDEN_TOP.has(top)) return false;
  if (!PURGE_ALLOWED_TOP.has(top)) return false;
  return true;
}

function dirSizeBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) total += dirSizeBytes(p);
      else if (ent.isFile()) total += statSync(p).size;
    } catch {
      /* skip unreadable */
    }
  }
  return total;
}

function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function readActiveRunId(workbenchRoot: string): string | null {
  const p = path.join(workbenchRoot, "state", "orchestrator.json");
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { activeRunId?: string };
    return raw.activeRunId ?? null;
  } catch {
    return null;
  }
}

function runModifiedAt(runDir: string): number {
  try {
    return statSync(runDir).mtimeMs;
  } catch {
    return 0;
  }
}

/** Scan Workbench for purge candidates — read-only, no deletes. */
export function planWorkbenchPurge(
  workbench: string,
  policy: PurgePolicy = DEFAULT_PURGE_POLICY,
): PurgePlan {
  const workbenchRoot = resolveWorkbenchRoot(workbench);
  const activeRunId = readActiveRunId(workbenchRoot);
  const now = Date.now();
  const candidates: PurgeCandidate[] = [];

  const runsDir = path.join(workbenchRoot, "runs");
  if (existsSync(runsDir)) {
    const runDirs = readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const sorted = runDirs
      .map((name) => ({ name, mtime: runModifiedAt(path.join(runsDir, name)) }))
      .sort((a, b) => b.mtime - a.mtime);

    const keepSet = new Set(sorted.slice(0, policy.runsKeepRecent).map((r) => r.name));
    const retentionMs = policy.runsRetentionDays * 86_400_000;

    for (const { name, mtime } of sorted) {
      if (activeRunId && name === activeRunId) continue;
      const runPath = path.join(runsDir, name);
      if (!isSafePurgePath(workbenchRoot, runPath)) continue;

      const bytes = dirSizeBytes(runPath);
      const age = now - mtime;

      if (policy.purgeEmptyRuns && isEmptyDir(runPath)) {
        candidates.push({
          relativePath: path.join("runs", name),
          reason: "empty run directory",
          bytes,
          category: "run_empty",
        });
        continue;
      }

      if (keepSet.has(name)) continue;

      if (age >= retentionMs) {
        candidates.push({
          relativePath: path.join("runs", name),
          reason: `run older than ${policy.runsRetentionDays}d (keep-recent=${policy.runsKeepRecent} exempt)`,
          bytes,
          category: "run_terminal",
        });
      }
    }
  }

  const stagingDir = path.join(workbenchRoot, "staging");
  if (existsSync(stagingDir)) {
    const stagingRetentionMs = policy.stagingRetentionDays * 86_400_000;
    for (const ent of readdirSync(stagingDir, { withFileTypes: true })) {
      const p = path.join(stagingDir, ent.name);
      if (!isSafePurgePath(workbenchRoot, p)) continue;
      try {
        const st = lstatSync(p);
        const age = now - st.mtimeMs;
        if (age >= stagingRetentionMs) {
          const bytes = ent.isDirectory() ? dirSizeBytes(p) : st.size;
          candidates.push({
            relativePath: path.join("staging", ent.name),
            reason: `staging artifact older than ${policy.stagingRetentionDays}d`,
            bytes,
            category: "staging_stale",
          });
        }
      } catch {
        /* skip */
      }
    }
  }

  const totalBytes = candidates.reduce((s, c) => s + c.bytes, 0);

  return {
    workbenchRoot,
    scannedAt: new Date().toISOString(),
    policy,
    protectedNote:
      "NEVER touches missions/, config/, queue/, state/, prompts/, repo, Vault, or paths outside AgentWorkbench.",
    candidates,
    totalBytes,
    activeRunId,
  };
}

/** Execute purge plan — only deletes paths validated by isSafePurgePath. */
export function executeWorkbenchPurge(
  workbench: string,
  plan: PurgePlan,
  opts: { dryRun?: boolean } = {},
): PurgeResult {
  const dryRun = opts.dryRun ?? true;
  const root = resolveWorkbenchRoot(workbench);
  const deleted: string[] = [];
  const skipped: string[] = [];
  const errors: { path: string; error: string }[] = [];
  let bytesFreed = 0;

  for (const c of plan.candidates) {
    const abs = path.join(root, c.relativePath);
    if (!isSafePurgePath(root, abs)) {
      skipped.push(c.relativePath);
      errors.push({ path: c.relativePath, error: "failed safety gate" });
      continue;
    }

    if (dryRun) {
      deleted.push(c.relativePath);
      bytesFreed += c.bytes;
      continue;
    }

    try {
      rmSync(abs, { recursive: true, force: true, maxRetries: 2 });
      deleted.push(c.relativePath);
      bytesFreed += c.bytes;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ path: c.relativePath, error: msg });
      skipped.push(c.relativePath);
    }
  }

  return {
    executedAt: new Date().toISOString(),
    dryRun,
    deleted,
    skipped,
    errors,
    bytesFreed,
  };
}

export function writePurgeReport(workbench: string, plan: PurgePlan, result?: PurgeResult): string {
  const outDir = path.join(workbench, "missions", "juno-workbench-cleanup-2026");
  mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "purge-report.json");
  writeFileSync(
    reportPath,
    `${JSON.stringify({ plan, result }, null, 2)}\n`,
    "utf8",
  );
  return reportPath;
}
