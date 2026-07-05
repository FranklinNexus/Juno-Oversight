/**
 * Bounded git commit + push after verified mission phases (no force-push).
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface AutoPushConfig {
  enabled?: boolean;
  repos?: Array<{
    id: string;
    root: string;
    remote?: string;
    branch?: string;
    /** Mission id allowlist; empty = all with autoPush brief tag */
    missions?: string[];
  }>;
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
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: (r.status ?? 1) === 0, out };
}

function hasForbiddenDiff(text: string): boolean {
  return /\bforce\b|--force|-f\b.*push|push.*--force/i.test(text);
}

export function tryGitPromoteForRepo(
  repoRoot: string,
  opts: { missionId?: string; message: string; repoId?: string },
): GitPromoteResult {
  const root = path.resolve(repoRoot);
  const base: GitPromoteResult = { repoId: opts.repoId ?? path.basename(root), root, pushed: false };

  if (!existsSync(path.join(root, ".git"))) {
    return { ...base, skipped: "not a git repo" };
  }

  const status = runGit(root, ["status", "--porcelain"]);
  if (!status.ok) return { ...base, error: status.out };
  if (!status.out.trim()) return { ...base, skipped: "clean working tree" };

  const diffStat = runGit(root, ["diff", "--stat"]);
  if (diffStat.out && hasForbiddenDiff(diffStat.out)) {
    return { ...base, skipped: "forbidden pattern in diff metadata" };
  }

  const fileCount = status.out.split("\n").filter(Boolean).length;
  const cfg = loadAutoPushConfig(process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench");
  const maxFiles = cfg.maxFilesPerPush ?? 80;
  if (fileCount > maxFiles) {
    return { ...base, skipped: `too many changed files (${fileCount}>${maxFiles}) — human review` };
  }

  runGit(root, ["add", "-A"]);
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

  for (const repo of repos) {
    if (repo.missions?.length && opts.missionId && !repo.missions.includes(opts.missionId)) {
      if (!briefAutoPush) continue;
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

    const r = tryGitPromoteForRepo(repo.root, { missionId: opts.missionId, message: msg, repoId: repo.id });
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
