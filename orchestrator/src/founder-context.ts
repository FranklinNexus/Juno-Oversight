/**
 * Founder context — read-only understanding of human ambitions (not identical copy).
 * Sources: Vault Juno/inbox/_profile.md + read-only 20_Projects scan + alignment config.
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface FounderTheme {
  id: string;
  label: string;
  keywords: string[];
  /** Juno constitution ambition ids this theme supports */
  ambitions?: string[];
  /** Missions that directly serve this theme */
  missions?: string[];
  /** How Juno helps without mirroring the goal 1:1 */
  junoRole?: string;
}

export interface FounderAlignmentConfig {
  themes?: FounderTheme[];
  /** Drive preference: balanced | wisdomechoes | lrif */
  driveStrategy?: "balanced" | "wisdomechoes" | "lrif";
  /** Vault-relative paths (read-only, titles + mtime only) */
  readOnlyVaultPaths?: string[];
  maxRecentNotes?: number;
}

export interface RecentVaultNote {
  relPath: string;
  title: string;
  mtime: string;
  preview?: string;
}

export interface FounderContext {
  loadedAt: string;
  profilePath?: string;
  /** Parsed from _profile.md ## 当前重心 */
  currentFocus: string[];
  /** Free text from ## 业务与野心 or ## 定制提示 */
  ambitionText: string;
  dailyRhythm?: string;
  themes: FounderTheme[];
  /** Themes matched from currentFocus */
  activeThemes: FounderTheme[];
  recentNotes: RecentVaultNote[];
  /** Human-readable alignment summary for digest */
  alignmentSummary: string[];
  driveStrategy: "balanced" | "wisdomechoes" | "lrif";
}

function workbenchConfigPath(workbench: string): string {
  return path.join(workbench, "config.yaml");
}

export function resolveVaultPaths(workbench: string): { vaultPath: string; junoInbox: string } | null {
  const cfgP = workbenchConfigPath(workbench);
  if (!existsSync(cfgP)) return null;
  try {
    const raw = readFileSync(cfgP, "utf8");
    const vaultMatch = raw.match(/vault_path:\s*["']?([^"'\n]+)/);
    const junoRootMatch = raw.match(/vault_juno_root:\s*["']?([^"'\n]+)/);
    if (!vaultMatch) return null;
    const vaultPath = vaultMatch[1].trim();
    const junoRoot = junoRootMatch?.[1]?.trim() ?? "Juno";
    return { vaultPath, junoInbox: path.join(vaultPath, junoRoot, "inbox") };
  } catch {
    return null;
  }
}

export function loadFounderAlignmentConfig(workbench: string): FounderAlignmentConfig {
  const p = path.join(workbench, "config", "founder-alignment.json");
  if (!existsSync(p)) return { themes: [], readOnlyVaultPaths: ["20_Projects"], maxRecentNotes: 8 };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as FounderAlignmentConfig;
  } catch {
    return { themes: [], readOnlyVaultPaths: ["20_Projects"], maxRecentNotes: 8 };
  }
}

function extractSection(md: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "im");
  const m = md.match(re);
  if (!m || m.index === undefined) return "";
  const start = m.index + m[0].length;
  const rest = md.slice(start);
  const next = rest.search(/^##\s+/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

function parseBulletList(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.replace(/^-\s+/, "").trim())
    .filter(Boolean);
}

function titleFromMd(relPath: string, maxChars = 80): string {
  const base = path.basename(relPath, path.extname(relPath));
  return base.slice(0, maxChars);
}

function readNotePreview(fullPath: string): string {
  try {
    const text = readFileSync(fullPath, "utf8");
    const cleaned = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("- ") && !l.startsWith(">"))
      .join(" ");
    return cleaned.slice(0, 120);
  } catch {
    return "";
  }
}

function scanRecentNotes(vaultPath: string, relPaths: string[], maxNotes: number): RecentVaultNote[] {
  const notes: RecentVaultNote[] = [];
  for (const rel of relPaths) {
    const root = path.join(vaultPath, rel);
    if (!existsSync(root)) continue;
    walkMd(root, vaultPath, notes, 3);
  }
  notes.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return notes.slice(0, maxNotes);
}

function walkMd(dir: string, vaultPath: string, out: RecentVaultNote[], depth: number): void {
  if (depth <= 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkMd(full, vaultPath, out, depth - 1);
    } else if (name.endsWith(".md")) {
      const relPath = path.relative(vaultPath, full).replace(/\\/g, "/");
      const preview = /20_Projects\/投资\/watch\//.test(relPath) ? readNotePreview(full) : "";
      out.push({
        relPath,
        title: titleFromMd(name),
        mtime: st.mtime.toISOString(),
        preview: preview || undefined,
      });
    }
  }
}

function matchThemes(focusLines: string[], themes: FounderTheme[]): FounderTheme[] {
  const hit = new Map<string, FounderTheme>();
  const corpus = focusLines.join(" ").toLowerCase();
  for (const theme of themes) {
    for (const kw of theme.keywords) {
      if (corpus.includes(kw.toLowerCase())) {
        hit.set(theme.id, theme);
        break;
      }
    }
  }
  return [...hit.values()];
}

export function loadFounderContext(workbench: string): FounderContext {
  const cfg = loadFounderAlignmentConfig(workbench);
  const themes = cfg.themes ?? [];
  const paths = resolveVaultPaths(workbench);
  const empty: FounderContext = {
    loadedAt: new Date().toISOString(),
    currentFocus: [],
    ambitionText: "",
    themes,
    activeThemes: [],
    recentNotes: [],
    alignmentSummary: ["No Vault profile — edit Juno/inbox/_profile.md"],
    driveStrategy: cfg.driveStrategy ?? "balanced",
  };
  if (!paths) return empty;

  const profilePath = path.join(paths.junoInbox, "_profile.md");
  if (!existsSync(profilePath)) return { ...empty, profilePath };

  const md = readFileSync(profilePath, "utf8");
  const currentFocus = parseBulletList(extractSection(md, "当前重心"));
  const ambitionText =
    extractSection(md, "业务与野心") ||
    extractSection(md, "定制提示（自由文本）") ||
    extractSection(md, "定制提示");
  const dailyRhythm = extractSection(md, "每日节奏");
  const activeThemes = matchThemes(currentFocus, themes);
  const recentNotes = scanRecentNotes(
    paths.vaultPath,
    cfg.readOnlyVaultPaths ?? ["20_Projects"],
    cfg.maxRecentNotes ?? 8,
  );

  const alignmentSummary = buildAlignmentSummary(currentFocus, activeThemes, recentNotes);

  return {
    loadedAt: new Date().toISOString(),
    profilePath,
    currentFocus,
    ambitionText,
    dailyRhythm,
    themes,
    activeThemes,
    recentNotes,
    alignmentSummary,
    driveStrategy: cfg.driveStrategy ?? "balanced",
  };
}

function buildAlignmentSummary(
  focus: string[],
  activeThemes: FounderTheme[],
  recentNotes: RecentVaultNote[],
): string[] {
  const lines: string[] = [];
  if (focus.length) {
    lines.push(`你的当前重心：${focus.join("；")}`);
  }
  for (const t of activeThemes) {
    const role = t.junoRole ? ` — Juno 角色：${t.junoRole}` : "";
    lines.push(`[${t.id}] ${t.label}${role}`);
  }
  if (recentNotes.length) {
    lines.push(`近期项目笔记（只读）：${recentNotes.slice(0, 4).map((n) => n.title).join("、")}`);
    const watch = recentNotes.find((n) => n.preview);
    if (watch?.preview) {
      lines.push(`投资观察摘要：${watch.preview}`);
    }
  }
  if (lines.length === 0) {
    lines.push("在 _profile.md 填写 ## 当前重心 与 ## 业务与野心，Juno 会据此加权自主 queue");
  }
  return lines;
}

/** Boost proposal score when mission serves founder active themes (0..0.25). */
export function alignmentBoostForMission(missionId: string, ctx: FounderContext): number {
  if (!ctx.activeThemes.length) return 0;
  let boost = 0;
  for (const theme of ctx.activeThemes) {
    if (theme.missions?.includes(missionId)) boost = Math.max(boost, 0.2);
    else if (theme.ambitions?.some((a) => missionId.includes(a.replace(/-/g, "")))) boost = Math.max(boost, 0.08);
  }
  return boost;
}

export function alignmentBoostForAmbition(ambitionId: string, ctx: FounderContext): number {
  for (const theme of ctx.activeThemes) {
    if (theme.ambitions?.includes(ambitionId)) return 0.15;
  }
  return 0;
}

export function writeFounderContextSnapshot(workbench: string, ctx: FounderContext): void {
  const p = path.join(workbench, "state", "founder-context.json");
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(ctx, null, 2)}\n`, "utf8");
}
