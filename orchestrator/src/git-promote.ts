/**
 * Bounded git commit + push after verified mission phases (no force-push).
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface AutoPushRepoConfig {
  id: string;
  root: string;
  remote?: string;
  branch?: string;
  /** Mission id allowlist; omit only with allowAllMissions: true */
  missions?: string[];
  /** Legacy: push on any mission verify (dangerous for monorepos). Default false. */
  allowAllMissions?: boolean;
  /** When set, only stage/commit paths under these prefixes */
  pathPrefixes?: string[];
}

export interface AutoPushConfig {
  enabled?: boolean;
  repos?: AutoPushRepoConfig[];
  requireVerifyPass?: boolean;
  maxFilesPerPush?: number;
}

export interface GitPromoteResult {
  repoId: string;
  root: string;
  pushed: boolean;
  commit?: string;
  skipped?: string;
  error?: string;
}

function configPath(workbench: string): string {
  return path.join(workbench, "config", "auto-push.json");
}

function logPath(workbench: string): string {
  return path.join(workbench, "state", "git-promote-log.jsonl");
}

export function loadAutoPushConfig(workbench: string): AutoPushConfig {
  const p = configPath(workbench);
  if (!existsSync(p)) return { enabled: false, repos: [] };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AutoPushConfig;
  } catch {
    return { enabled: false, repos: [] };
  }
}

function runGit(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\s+$/, "");
  return { ok: (r.status ?? 1) === 0, out };
}

function hasForbiddenDiff(text: string): boolean {
  return /\bforce\b|--force|-f\b.*push|push.*--force/i.test(text);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\r$/, "");
}

function parseStatusPaths(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const m = line.match(/^(..)\s+(.*)$/);
      const raw = (m ? m[2] : line).trim();
      const arrow = raw.indexOf(" -> ");
      return arrow >= 0 ? raw.slice(arrow + 4).trim() : raw;
    });
}

function filterPathsByPrefixes(paths: string[], prefixes?: string[]): string[] {
  if (!prefixes?.length) return paths;
  const norms = prefixes.map((p) => normalizePath(p));
  return paths.filter((file) => {
    const f = normalizePath(file);
    return norms.some((p) => f === p.replace(/\/$/, "") || f.startsWith(p));
  });
}

export function tryGitPromoteForRepo(
  repoRoot: string,
  opts: {
    missionId?: string;
    message: string;
    repoId?: string;
    pathPrefixes?: string[];
    maxFilesPerPush?: number;
  },
): GitPromoteResult {
  const root = path.resolve(repoRoot);
  const base: GitPromoteResult = { repoId: opts.repoId ?? path.basename(root), root, pushed: false };

  if (!existsSync(path.join(root, ".git"))) {
    return { ...base, skipped: "not a git repo" };
  }

  const status = runGit(root, ["status", "--porcelain"]);
  if (!status.ok) return { ...base, error: status.out };
  if (!status.out.trim()) return { ...base, skipped: "clean working tree" };

  const allPaths = parseStatusPaths(status.out);
  const paths = filterPathsByPrefixes(allPaths, opts.pathPrefixes);
  if (opts.pathPrefixes?.length && paths.length === 0) {
    return { ...base, skipped: "no changes under pathPrefixes" };
  }

  const diffStat = runGit(root, ["diff", "--stat", "--", ...paths]);
  if (diffStat.out && hasForbiddenDiff(diffStat.out)) {
    return { ...base, skipped: "forbidden pattern in diff metadata" };
  }

  const maxFiles = opts.maxFilesPerPush ?? 80;
  if (paths.length > maxFiles) {
    return {
      ...base,
      skipped: `too many changed files (${paths.length}>${maxFiles}) — human review`,
    };
  }

  if (paths.length > 0) {
    runGit(root, ["add", "--", ...paths]);
  } else {
    runGit(root, ["add", "-A"]);
  }

  const commit = runGit(root, ["commit", "-m", opts.message]);
  if (!commit.ok) {
    if (/nothing to commit/i.test(commit.out)) return { ...base, skipped: "nothing to commit" };
    return { ...base, error: commit.out };
  }

  const sha = runGit(root, ["rev-parse", "--short", "HEAD"]);
  const push = runGit(root, ["push", "origin", "HEAD"]);
  if (!push.ok) return { ...base, error: push.out, commit: sha.out };

  return { ...base, pushed: true, commit: sha.out };
}

export function repoEligibleForMission(
  repo: AutoPushRepoConfig,
  missionId: string | undefined,
  briefAutoPush: boolean,
): { ok: true } | { ok: false; reason: string } {
  const hasAllowlist = Array.isArray(repo.missions) && repo.missions.length > 0;
  if (!hasAllowlist && repo.allowAllMissions !== true && !briefAutoPush) {
    return { ok: false, reason: "repo has no mission allowlist" };
  }
  if (hasAllowlist && missionId && !repo.missions!.includes(missionId) && !briefAutoPush) {
    return { ok: false, reason: "mission not in repo allowlist" };
  }
  return { ok: true };
}

export function tryAutoGitPush(
  workbench: string,
  opts: { missionId?: string; phaseId?: string; verifyPassed?: boolean },
): GitPromoteResult[] {
  const cfg = loadAutoPushConfig(workbench);
  if (cfg.enabled === false) return [];

  const planPath = path.join(workbench, "state", "last-brief-plan.json");
  let briefAutoPush = false;
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, "utf8")) as { autoPush?: boolean; missionId?: string };
      if (plan.missionId === opts.missionId) briefAutoPush = plan.autoPush === true;
    } catch {
      /* ignore */
    }
  }

  const repos = cfg.repos ?? [];
  if (repos.length === 0) return [];

  const results: GitPromoteResult[] = [];
  const msg = `juno: ${opts.missionId ?? "mission"} ${opts.phaseId ?? ""}`.trim();
  const maxFiles = cfg.maxFilesPerPush ?? 80;

  for (const repo of repos) {
    const eligible = repoEligibleForMission(repo, opts.missionId, briefAutoPush);
    if (!eligible.ok) {
      results.push({
        repoId: repo.id,
        root: repo.root,
        pushed: false,
        skipped: eligible.reason,
      });
      continue;
    }

    if (cfg.requireVerifyPass !== false && opts.verifyPassed === false) {
      results.push({
        repoId: repo.id,
        root: repo.root,
        pushed: false,
        skipped: "verify not passed",
      });
      continue;
    }

    const r = tryGitPromoteForRepo(repo.root, {
      missionId: opts.missionId,
      message: msg,
      repoId: repo.id,
      pathPrefixes: repo.pathPrefixes,
      maxFilesPerPush: maxFiles,
    });
    results.push(r);

    mkdirSync(path.join(workbench, "state"), { recursive: true });
    appendFileSync(
      logPath(workbench),
      `${JSON.stringify({ ts: new Date().toISOString(), ...r, missionId: opts.missionId })}\n`,
      "utf8",
    );
  }

  return results;
}
