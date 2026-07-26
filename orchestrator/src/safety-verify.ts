import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type BigIntStats,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { classifyShellCommand } from "./safety-doctrine.js";
import { resolveMissionDirectory } from "./workbench-paths.js";

export type SafetyFinding = {
  category: "destructive_cmd" | "secret_pattern" | "scope_path";
  severity: "warn" | "block";
  message: string;
};

export type SafetyVerifyReport = {
  ok: boolean;
  findings: SafetyFinding[];
};

export type GitTreeSnapshot = {
  root: string;
  head?: string;
  files: Record<string, string>;
};

export type FileTreeSnapshot = {
  root: string;
  files: Record<string, string>;
};

export type MissionSafetyBaseline = {
  version: 3;
  missionId: string;
  capturedAt: string;
  scopeLockText: string;
  scopeLockHash: string;
  roots: GitTreeSnapshot[];
  workbench: FileTreeSnapshot;
};

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

interface GitCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

class HardLinkSafetyError extends Error {
  constructor(filePath: string, links: bigint) {
    super(`Hard-linked files are forbidden in safety scope: ${filePath} (nlink=${links})`);
    this.name = "HardLinkSafetyError";
  }
}

function isMissionSafetyBaseline(
  value: Partial<MissionSafetyBaseline>,
  missionId: string,
  workbench: string,
): value is MissionSafetyBaseline {
  return (
    value.version === 3 &&
    value.missionId === missionId &&
    typeof value.scopeLockText === "string" &&
    typeof value.scopeLockHash === "string" &&
    value.scopeLockHash === hashText(value.scopeLockText) &&
    typeof value.workbench?.root === "string" &&
    path.isAbsolute(value.workbench.root) &&
    normalizeAbs(value.workbench.root) === normalizeAbs(workbench) &&
    typeof value.workbench.files === "object" &&
    Array.isArray(value.roots) &&
    value.roots.every(
      (root) =>
        typeof root?.root === "string" &&
        path.isAbsolute(root.root) &&
        typeof root.files === "object" &&
        (root.head === undefined || typeof root.head === "string"),
    )
  );
}

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/,
  /\b(?:authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9._~+/-]{12,}=*/i,
  /\b(?:set-)?cookie\s*[:=]\s*[^\r\n]{12,}/i,
  /\b(?:(?:access|refresh|id)[_-]?)?token\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{12,}/i,
  /\b(api[_-]?key|secret[_-]?key|password)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /\.env\.local\b.*(?:write|commit|add)/i,
];

const SCOPE_FORBIDDEN = [
  /obsidian\s*vault/i,
  /rmdir\s+.*vault/i,
  /rm\s+-rf\s+.*vault/i,
];

/** Readonly safety bundle for verify slots (AgentDojo / GuardAgent inspired). */
export function scanTextForSecrets(text: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) {
      findings.push({
        category: "secret_pattern",
        severity: "block",
        message: `Possible secret/credential pattern matched: ${re.source.slice(0, 40)}…`,
      });
    }
  }
  return findings;
}

export function scanTextForDestructiveCommands(text: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-") && !trimmed.includes("rmdir") && !trimmed.includes("rm ")) {
      continue;
    }
    const verdict = classifyShellCommand(trimmed);
    if (verdict.blocked) {
      findings.push({
        category: "destructive_cmd",
        severity: "block",
        message: verdict.reason ?? "Blocked destructive command pattern in checkpoint text.",
      });
    }
  }
  for (const re of SCOPE_FORBIDDEN) {
    if (re.test(text)) {
      findings.push({
        category: "scope_path",
        severity: "block",
        message: "Checkpoint references forbidden Vault/destructive scope.",
      });
    }
  }
  return findings;
}

export function runSafetyVerifyBundle(text: string): SafetyVerifyReport {
  const findings = [
    ...scanTextForSecrets(text),
    ...scanTextForDestructiveCommands(text),
  ];
  const ok = !findings.some((f) => f.severity === "block");
  return { ok, findings };
}

function gitCommandLabel(root: string, args: string[]): string {
  return `git ${args.join(" ")} (cwd=${root})`;
}

function gitErrorDetail(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ETIMEDOUT") return `timed out after ${GIT_TIMEOUT_MS}ms`;
  if (code === "ENOBUFS") {
    return `exceeded the ${GIT_MAX_BUFFER_BYTES}-byte output limit`;
  }
  return `${code ? `${code}: ` : ""}${error.message}`;
}

function compactGitStderr(stderr: string): string {
  return stderr.replace(/\s+/g, " ").trim().slice(0, 500);
}

function executeGit(root: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });
  const label = gitCommandLabel(root, args);
  if (result.error) {
    throw new Error(`Git observation failed: ${label}: ${gitErrorDetail(result.error)}`);
  }
  if (result.signal) {
    throw new Error(`Git observation failed: ${label}: terminated by ${result.signal}`);
  }
  if (!Number.isInteger(result.status)) {
    throw new Error(`Git observation failed: ${label}: ended without an exit status`);
  }
  return {
    status: result.status as number,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function requireGitSuccess(root: string, args: string[]): GitCommandResult {
  const result = executeGit(root, args);
  if (result.status !== 0) {
    const detail = compactGitStderr(result.stderr);
    throw new Error(
      `Git observation failed: ${gitCommandLabel(root, args)}: exited with status ${result.status}${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  return result;
}

function gitHistoryIsIntact(root: string, head?: string): boolean {
  if (!head) return true;
  const args = ["merge-base", "--is-ancestor", head, "HEAD"];
  const result = executeGit(root, args);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const detail = compactGitStderr(result.stderr);
  throw new Error(
    `Git observation failed: ${gitCommandLabel(root, args)}: exited with status ${result.status}${
      detail ? `: ${detail}` : ""
    }`,
  );
}

function resolveGitRoot(candidate: string): string | null {
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) return null;
  const args = ["rev-parse", "--show-toplevel"];
  const result = executeGit(candidate, args);
  if (result.status !== 0) {
    if (/not a git repository/i.test(result.stderr)) return null;
    const detail = compactGitStderr(result.stderr);
    throw new Error(
      `Git observation failed: ${gitCommandLabel(candidate, args)}: exited with status ${result.status}${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  const resolved = result.stdout.trim();
  if (!resolved) {
    throw new Error(`Git observation failed: ${gitCommandLabel(candidate, args)}: empty root`);
  }
  return path.resolve(resolved);
}

function assertNotHardLinked(filePath: string): void {
  let linkStat: BigIntStats;
  try {
    linkStat = lstatSync(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (linkStat.isFile() && linkStat.nlink > BigInt(1)) {
    throw new HardLinkSafetyError(filePath, linkStat.nlink);
  }
}

function hashFile(filePath: string): string {
  if (!existsSync(filePath)) return "deleted";
  assertNotHardLinked(filePath);
  const st = statSync(filePath);
  if (!st.isFile()) return "not-file";
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizeAbs(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
}

function changedWorkingTreeFiles(root: string, base = "HEAD"): string[] {
  const files = new Set<string>();
  for (const args of [
    ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]) {
    const result = requireGitSuccess(root, args);
    for (const file of result.stdout.split("\0")) {
      if (file) files.add(normalizeRel(file));
    }
  }
  return [...files].sort();
}

type GitHistoryObservation = {
  files: string[];
  additions: string;
};

function committedHistorySince(root: string, head?: string): GitHistoryObservation {
  if (!head) return { files: [], additions: "" };
  const range = `${head}..HEAD`;
  const files = requireGitSuccess(root, [
    "log",
    "-m",
    "--format=",
    "--name-only",
    "-z",
    "--no-renames",
    range,
    "--",
  ]).stdout
    .split("\0")
    .filter(Boolean)
    .map(normalizeRel);
  const patch = requireGitSuccess(root, [
    "log",
    "-m",
    "--format=",
    "--patch",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--no-color",
    range,
    "--",
  ]).stdout;
  return { files: [...new Set(files)].sort(), additions: additionText(patch) };
}

function trackedGitFiles(root: string): string[] {
  return requireGitSuccess(root, ["ls-files", "--cached", "-z"]).stdout
    .split("\0")
    .filter(Boolean)
    .map(normalizeRel);
}

function assertGitFilesNotHardLinked(root: string, extraFiles: string[] = []): Set<string> {
  const tracked = new Set(trackedGitFiles(root));
  const files = new Set([...tracked, ...extraFiles]);
  for (const file of files) assertNotHardLinked(path.join(root, file));
  return tracked;
}

function diffForFile(root: string, file: string, tracked: boolean, head?: string): string {
  const absolute = path.join(root, file);
  if (existsSync(absolute)) assertNotHardLinked(absolute);
  const observed = requireGitSuccess(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--no-color",
    head ?? "HEAD",
    "--",
    file,
  ]).stdout;
  const untrackedPath = path.join(root, file);
  let untracked = "";
  if (existsSync(untrackedPath) && !tracked) {
    try {
      assertNotHardLinked(untrackedPath);
      const text = readFileSync(untrackedPath, "utf8");
      untracked = text.split(/\r?\n/).map((line) => `+${line}`).join("\n");
    } catch (error) {
      if (error instanceof HardLinkSafetyError) throw error;
      // binary or unreadable file: path scope still applies
    }
  }
  return [observed, untracked].filter(Boolean).join("\n");
}

function additionText(diff: string): string {
  const lines = diff.split(/\r?\n/);
  const structuredPatch = lines.some(
    (line) => line.startsWith("diff --git ") || line.startsWith("@@"),
  );
  let inHunk = false;
  const additions: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("+") && (inHunk || !structuredPatch)) {
      additions.push(line.slice(1));
    }
  }
  return additions.join("\n");
}

export function missionSafetyBaselinePath(workbench: string, missionId: string): string {
  return path.join(workbench, "state", "safety-baselines", `${hashText(missionId)}.json`);
}

function scopeLockPath(workbench: string, missionId: string): string {
  return path.join(resolveMissionDirectory(workbench, missionId), "scope-lock.md");
}

function readScopeLock(workbench: string, missionId: string): string {
  const p = scopeLockPath(workbench, missionId);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function absolutePathsFromText(text: string): string[] {
  const matches = text.match(/[A-Za-z]:[\\/][^\s`"'<>|]+/g) ?? [];
  return matches.map((m) => path.resolve(m));
}

function discoverGitRoots(
  workbench: string,
  missionId: string,
  scopeLock = readScopeLock(workbench, missionId),
): string[] {
  const candidates = [
    process.env.JUNO_OVERSIGHT_ROOT,
    workbench,
    ...absolutePathsFromText(scopeLock),
  ].filter((p): p is string => Boolean(p?.trim()));
  const roots = new Set<string>();
  for (const candidate of candidates) {
    const root = resolveGitRoot(candidate);
    if (root) roots.add(root);
  }
  return [...roots].sort();
}

function captureGitRoot(root: string): GitTreeSnapshot {
  const head = requireGitSuccess(root, ["rev-parse", "HEAD"]);
  const headCommit = head.stdout.trim();
  const changedFiles = changedWorkingTreeFiles(root, headCommit);
  assertGitFilesNotHardLinked(root, changedFiles);
  const files: Record<string, string> = {};
  for (const file of changedFiles) {
    files[file] = hashFile(path.join(root, file));
  }
  return {
    root,
    head: headCommit,
    files,
  };
}

const WORKBENCH_SNAPSHOT_EXCLUDES = new Set([".git", "runs", "state"]);

function captureFileTree(root: string): FileTreeSnapshot {
  const files: Record<string, string> = {};

  function walk(current: string, relativeDir: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!relativeDir && WORKBENCH_SNAPSHOT_EXCLUDES.has(entry.name)) continue;
      const relative = normalizeRel(path.join(relativeDir, entry.name));
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(absolute).replace(/\\/g, "/");
        let targetHash = "unreadable";
        try {
          targetHash = statSync(absolute).isFile() ? hashFile(absolute) : "not-file";
        } catch {
          /* keep unreadable marker */
        }
        files[relative] = `symlink:${hashText(target)}:${targetHash}`;
      } else if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        files[relative] = hashFile(absolute);
      }
    }
  }

  walk(root, "");
  return { root: path.resolve(root), files };
}

function changedFileTreeFiles(snapshot: FileTreeSnapshot, ignored: Set<string>): string[] {
  const current = captureFileTree(snapshot.root);
  const files = new Set([...Object.keys(snapshot.files), ...Object.keys(current.files)]);
  return [...files]
    .filter((file) => !ignored.has(normalizeRel(file)))
    .filter((file) => snapshot.files[file] !== current.files[file])
    .sort();
}

export function captureMissionSafetyBaseline(
  workbench: string,
  missionId: string,
): MissionSafetyBaseline {
  const scopeLockText = readScopeLock(workbench, missionId);
  return {
    version: 3,
    missionId,
    capturedAt: new Date().toISOString(),
    scopeLockText,
    scopeLockHash: hashText(scopeLockText),
    roots: discoverGitRoots(workbench, missionId, scopeLockText).map(captureGitRoot),
    workbench: captureFileTree(workbench),
  };
}

export function ensureMissionSafetyBaseline(
  workbench: string,
  missionId: string,
): MissionSafetyBaseline {
  const p = missionSafetyBaselinePath(workbench, missionId);
  if (existsSync(p)) {
    try {
      const existing = JSON.parse(readFileSync(p, "utf8")) as Partial<MissionSafetyBaseline>;
      if (isMissionSafetyBaseline(existing, missionId, workbench)) return existing;
    } catch (error) {
      throw new Error(`Safety baseline is unreadable and will not be replaced: ${p}`, {
        cause: error,
      });
    }
    throw new Error(`Safety baseline is invalid and will not be replaced: ${p}`);
  }
  const baseline = captureMissionSafetyBaseline(workbench, missionId);
  mkdirSync(path.dirname(p), { recursive: true });
  const temp = `${p}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(baseline, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (existsSync(p)) throw new Error(`Safety baseline appeared during capture: ${p}`);
    renameSync(temp, p);
  } finally {
    rmSync(temp, { force: true });
  }
  return baseline;
}

type ScopeTarget = "any" | "git" | "workbench";

function extractAllowedPathPatterns(scopeLock: string, target: Exclude<ScopeTarget, "any">): string[] {
  const patterns = new Map<string, ScopeTarget>();
  let inAllowed = false;
  let currentTarget: ScopeTarget = "any";

  for (const line of scopeLock.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+/.test(line);
    if (heading) {
      inAllowed = /允许|allow|allowed/i.test(line);
      currentTarget = /workbench/i.test(line)
        ? "workbench"
        : /juno|仓库|repo|wiki/i.test(line)
          ? "git"
          : "any";
    }
    if (/允许|allow|allowed/i.test(line)) inAllowed = true;
    if (heading && !/允许|allow|allowed/i.test(line)) continue;
    if (!inAllowed) continue;

    for (const match of line.matchAll(/`([^`]+)`/g)) {
      patterns.set(match[1].trim(), currentTarget);
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      const raw = bullet[1].replace(/\s+#.*$/, "").trim();
      if (/[/\\*]|^[A-Za-z]:/.test(raw)) patterns.set(raw, currentTarget);
    }
  }

  return [...patterns.entries()]
    .filter(([pattern, scopeTarget]) => pattern && (scopeTarget === "any" || scopeTarget === target))
    .map(([pattern]) => pattern);
}

function globToRegex(pattern: string): RegExp {
  const normalized = normalizeRel(pattern.replace(/\\/g, "/"));
  let glob = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "*" && normalized[i + 1] === "*") {
      if (normalized[i + 2] === "/") {
        glob += "(?:.*/)?";
        i += 2;
      } else {
        glob += ".*";
        i += 1;
      }
      continue;
    }
    if (char === "*") {
      glob += "[^/]*";
      continue;
    }
    glob += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${glob}(?:/.*)?$`, "i");
}

function pathAllowed(root: string, relFile: string, patterns: string[]): boolean {
  const rel = normalizeRel(relFile);
  const abs = `${normalizeAbs(root)}/${rel}`;
  return patterns.some((pattern) => {
    const p = pattern.trim();
    if (!p) return false;
    if (/^[A-Za-z]:[\\/]/.test(p)) {
      return globToRegex(p).test(abs);
    }
    return globToRegex(p).test(rel);
  });
}

function changedFilesSinceBaseline(
  root: GitTreeSnapshot,
): { files: string[]; tracked: Set<string>; historyAdditions: string } {
  const history = committedHistorySince(root.root, root.head);
  const files = new Set<string>(history.files);
  const workingFiles = changedWorkingTreeFiles(root.root, root.head ?? "HEAD");
  const tracked = assertGitFilesNotHardLinked(root.root, [
    ...Object.keys(root.files),
    ...workingFiles,
  ]);
  const candidates = new Set([
    ...Object.keys(root.files),
    ...workingFiles,
  ]);
  for (const file of candidates) {
    const fingerprint = hashFile(path.join(root.root, file));
    if (root.files[file] !== fingerprint) files.add(file);
  }
  return {
    files: [...files].sort(),
    tracked,
    historyAdditions: history.additions,
  };
}

function observationBlock(context: string, error: unknown): SafetyFinding {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    category: "scope_path",
    severity: "block",
    message: `${context}: ${detail}`,
  };
}

export function runMissionDiffSafetyVerify(
  workbench: string,
  missionId: string,
): SafetyVerifyReport {
  const findings: SafetyFinding[] = [];
  const baselinePath = missionSafetyBaselinePath(workbench, missionId);
  let baseline: MissionSafetyBaseline | null = null;
  if (existsSync(baselinePath)) {
    try {
      const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as Partial<MissionSafetyBaseline>;
      if (isMissionSafetyBaseline(parsed, missionId, workbench)) baseline = parsed;
    } catch {
      /* reported below */
    }
  }
  if (!baseline) {
    return {
      ok: false,
      findings: [
        {
          category: "scope_path",
          severity: "block",
          message: "mission has no valid v3 safety baseline; run an implement slot before verify",
        },
      ],
    };
  }
  const liveScopeLock = readScopeLock(workbench, missionId);
  if (hashText(liveScopeLock) !== baseline.scopeLockHash) {
    findings.push({
      category: "scope_path",
      severity: "block",
      message: "scope-lock changed after the safety baseline was captured",
    });
  }
  const baselineRoots = baseline.roots.map((root) => normalizeAbs(root.root)).sort();
  try {
    const expectedRoots = discoverGitRoots(workbench, missionId, baseline.scopeLockText)
      .map(normalizeAbs)
      .sort();
    if (JSON.stringify(expectedRoots) !== JSON.stringify(baselineRoots)) {
      findings.push({
        category: "scope_path",
        severity: "block",
        message: "Git root set changed after the safety baseline was captured",
      });
    }
  } catch (error) {
    findings.push(observationBlock("Git root discovery failed", error));
  }
  const gitAllowed = extractAllowedPathPatterns(baseline.scopeLockText, "git");
  const workbenchAllowed = extractAllowedPathPatterns(baseline.scopeLockText, "workbench");

  if (gitAllowed.length === 0 && workbenchAllowed.length === 0) {
    findings.push({
      category: "scope_path",
      severity: "block",
      message: "scope-lock has no allowed path patterns; refusing to verify mission diff",
    });
  }

  for (const root of baseline.roots) {
    if (!existsSync(root.root)) {
      findings.push({
        category: "scope_path",
        severity: "block",
        message: `Git safety baseline is unavailable or no longer an ancestor: ${root.root}`,
      });
      continue;
    }

    let historyIntact = false;
    try {
      historyIntact = gitHistoryIsIntact(root.root, root.head);
    } catch (error) {
      findings.push(observationBlock(`Git history observation failed for ${root.root}`, error));
      continue;
    }
    if (!historyIntact) {
      findings.push({
        category: "scope_path",
        severity: "block",
        message: `Git safety baseline is unavailable or no longer an ancestor: ${root.root}`,
      });
      continue;
    }

    let changedFiles: {
      files: string[];
      tracked: Set<string>;
      historyAdditions: string;
    };
    try {
      changedFiles = changedFilesSinceBaseline(root);
    } catch (error) {
      findings.push(observationBlock(`Git working-tree observation failed for ${root.root}`, error));
      continue;
    }
    findings.push(...scanTextForSecrets(changedFiles.historyAdditions));
    for (const file of changedFiles.files) {
      if (!pathAllowed(root.root, file, gitAllowed)) {
        findings.push({
          category: "scope_path",
          severity: "block",
          message: `Changed path outside mission scope: ${path.join(root.root, file)}`,
        });
      }
      try {
        const added = additionText(
          diffForFile(root.root, file, changedFiles.tracked.has(file), root.head),
        );
        findings.push(...scanTextForSecrets(added));
      } catch (error) {
        findings.push(
          observationBlock(`Git diff observation failed for ${path.join(root.root, file)}`, error),
        );
      }
    }
  }

  if (!existsSync(baseline.workbench.root)) {
    findings.push({
      category: "scope_path",
      severity: "block",
      message: `Workbench safety baseline root is unavailable: ${baseline.workbench.root}`,
    });
  } else {
    const ignored = new Set(["queue/now.yaml"]);
    const protectedMissionCheckpoint = normalizeRel(
      path.relative(
        baseline.workbench.root,
        path.join(resolveMissionDirectory(workbench, missionId), "checkpoint.md"),
      ),
    );
    try {
      for (const file of changedFileTreeFiles(baseline.workbench, ignored)) {
        if (normalizeRel(file) === protectedMissionCheckpoint) {
          findings.push({
            category: "scope_path",
            severity: "block",
            message: "Agent modified the read-only mission checkpoint control file",
          });
        }
        if (!pathAllowed(baseline.workbench.root, file, workbenchAllowed)) {
          findings.push({
            category: "scope_path",
            severity: "block",
            message: `Changed Workbench path outside mission scope: ${path.join(baseline.workbench.root, file)}`,
          });
        }
        const absolute = path.join(baseline.workbench.root, file);
        if (existsSync(absolute)) {
          try {
            assertNotHardLinked(absolute);
            findings.push(...scanTextForSecrets(readFileSync(absolute, "utf8")));
          } catch (error) {
            if (error instanceof HardLinkSafetyError) {
              findings.push(observationBlock("Workbench hard-link observation failed", error));
            }
            /* Binary or otherwise unreadable content is still path-checked above. */
          }
        }
      }
    } catch (error) {
      findings.push(observationBlock("Workbench tree observation failed", error));
    }
  }

  return {
    ok: !findings.some((f) => f.severity === "block"),
    findings,
  };
}

export function formatSafetyVerifyMarkdown(report: SafetyVerifyReport): string {
  const lines = ["## SAFETY_VERIFY", `- ok: ${report.ok ? "PASS" : "FAIL"}`];
  if (report.findings.length === 0) {
    lines.push("- findings: none");
  } else {
    for (const f of report.findings) {
      lines.push(`- [${f.severity}] ${f.category}: ${f.message}`);
    }
  }
  return lines.join("\n");
}
