/**
 * Drive Engine v1 — scan → tension → proposal (curiosity + ambition without human brief).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { computeAmbitionGaps, loadConstitution, type JunoConstitution } from "./constitution.js";
import { parseNowYaml } from "./queue-io.js";
import { compileBriefFromText, writeBriefMission } from "./mission-brief.js";
import { listWindowsComPorts } from "./mcp-provision.js";

export type TensionKind =
  | "ambition_gap"
  | "hardware_opportunity"
  | "queue_idle"
  | "human_inbox"
  | "research_gap"
  | "regression";

export interface DriveObservation {
  source: string;
  kind: TensionKind;
  summary: string;
  score: number;
  meta?: Record<string, unknown>;
}

export interface DriveProposal {
  id: string;
  hypothesis: string;
  tensionKinds: TensionKind[];
  score: number;
  confidence: number;
  needsHumanApproval: boolean;
  /** Known mission bootstrap or "compile_brief" */
  action: "bootstrap" | "compile_brief";
  missionId?: string;
  bootstrap?: string;
  briefText?: string;
  createdAt: string;
}

export interface DriveTickResult {
  scannedAt: string;
  observations: DriveObservation[];
  proposals: DriveProposal[];
  topProposal: DriveProposal | null;
  digestPath?: string;
  queued: boolean;
  missionId?: string;
}

function workbenchConfigPath(workbench: string): string {
  return path.join(workbench, "config.yaml");
}

export function readVaultJunoInbox(workbench: string): string | null {
  const cfgP = workbenchConfigPath(workbench);
  if (!existsSync(cfgP)) return null;
  try {
    const raw = readFileSync(cfgP, "utf8");
    const vaultMatch = raw.match(/vault_path:\s*["']?([^"'\n]+)/);
    const junoRootMatch = raw.match(/vault_juno_root:\s*["']?([^"'\n]+)/);
    if (!vaultMatch || !junoRootMatch) return null;
    return path.join(vaultMatch[1].trim(), junoRootMatch[1].trim(), "inbox");
  } catch {
    return null;
  }
}

function missionComplete(workbench: string, missionId: string): boolean {
  const cp = path.join(workbench, "missions", missionId, "checkpoint.md");
  if (!existsSync(cp)) return false;
  return /STATUS:\s*COMPLETE/i.test(readFileSync(cp, "utf8"));
}

function missionStarted(workbench: string, missionId: string): boolean {
  return existsSync(path.join(workbench, "missions", missionId, "progress.md"));
}

function driveStatePath(workbench: string): string {
  return path.join(workbench, "state", "drive-engine.json");
}

export function readDriveState(workbench: string): { lastScanAt?: string; lastProposalId?: string } {
  const p = driveStatePath(workbench);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function writeDriveState(workbench: string, patch: Record<string, unknown>): void {
  mkdirSync(path.join(workbench, "state"), { recursive: true });
  const prev = readDriveState(workbench);
  writeFileSync(driveStatePath(workbench), `${JSON.stringify({ ...prev, ...patch }, null, 2)}\n`, "utf8");
}

function gitDirty(repoRoot: string): boolean {
  if (!existsSync(path.join(repoRoot, ".git"))) return false;
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  return Boolean(r.stdout?.trim());
}

/** Map live signals → ambition metric evidence */
export function collectAmbitionEvidence(
  workbench: string,
  junoRepoRoot: string,
): Record<string, { satisfied: boolean; note?: string }> {
  const ports = listWindowsComPorts();
  const mcpCfg = path.join(workbench, "config", "mcp-servers.json");
  let serialEnabled = false;
  if (existsSync(mcpCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(mcpCfg, "utf8")) as { servers?: Array<{ id: string; enabled?: boolean }> };
      serialEnabled = cfg.servers?.some((s) => s.id === "serial-boards" && s.enabled) ?? false;
    } catch {
      /* ignore */
    }
  }

  return {
    "hardware-sovereignty:ports_scanned": {
      satisfied: ports.length >= 2,
      note: ports.length ? ports.join(", ") : "no COM ports",
    },
    "hardware-sovereignty:mcp_enabled": {
      satisfied: serialEnabled,
      note: serialEnabled ? "serial-boards enabled" : "serial-boards disabled or missing",
    },
    "agent-mind:drive_engine": {
      satisfied: existsSync(path.join(junoRepoRoot, "orchestrator", "src", "drive-engine.ts")),
      note: "drive-engine.ts present",
    },
    "agent-mind:constitution": {
      satisfied: existsSync(path.join(workbench, "config", "constitution.json")),
    },
    "agent-mind:research_mission": {
      satisfied: missionStarted(workbench, "juno-agent-drive-research-2026"),
      note: missionComplete(workbench, "juno-agent-drive-research-2026")
        ? "research COMPLETE"
        : "research in progress or not started",
    },
    "agent-mind:papers_100": {
      satisfied: existsSync(
        path.join(workbench, "missions", "juno-agent-drive-research-2026", "papers", "batch-04.yaml"),
      ),
      note: "100-paper corpus (4×25)",
    },
    "public-surface:wisdomechoes": {
      satisfied: missionComplete(workbench, "juno-wisdomechoes-axiom-blog-2026"),
    },
    "revenue:prototype": {
      satisfied: false,
      note: "no revenue prototype yet",
    },
  };
}

export function scanEnvironment(
  workbench: string,
  junoRepoRoot: string,
  constitution: JunoConstitution | null,
): DriveObservation[] {
  const obs: DriveObservation[] = [];
  const { now } = parseNowYaml(workbench);

  if (now.length === 0) {
    obs.push({
      source: "queue",
      kind: "queue_idle",
      summary: "Mission queue empty — Juno has no active slot",
      score: 0.85,
    });
  }

  const ports = listWindowsComPorts();
  if (ports.length >= 2 && !missionComplete(workbench, "juno-hardware-mcp-2026")) {
    obs.push({
      source: "hardware",
      kind: "hardware_opportunity",
      summary: `${ports.length} COM ports detected; hardware MCP mission incomplete`,
      score: 0.75,
      meta: { ports },
    });
  }

  if (
    !missionComplete(workbench, "juno-agent-drive-research-2026") &&
    !missionStarted(workbench, "juno-agent-drive-research-2026")
  ) {
    obs.push({
      source: "research",
      kind: "research_gap",
      summary: "No literature synthesis for curiosity/ambition/autonomy architecture",
      score: 0.9,
    });
  } else if (
    missionStarted(workbench, "juno-agent-drive-research-2026") &&
    !missionComplete(workbench, "juno-agent-drive-research-2026")
  ) {
    obs.push({
      source: "research",
      kind: "research_gap",
      summary: "Agent drive research mission in progress — continue batches",
      score: 0.7,
    });
  }

  const inbox = readVaultJunoInbox(workbench);
  if (inbox && existsSync(inbox)) {
    for (const name of readdirSync(inbox)) {
      if (name.startsWith(".") || name.startsWith("digest-")) continue;
      if (name === "brief.md") {
        const text = readFileSync(path.join(inbox, name), "utf8");
        if (text.includes("（在下方写你的任务）") || text.trim().length < 200) continue;
      }
      obs.push({
        source: "vault",
        kind: "human_inbox",
        summary: `Human inbox file: ${name}`,
        score: 0.95,
        meta: { path: path.join(inbox, name) },
      });
    }
  }

  if (gitDirty(junoRepoRoot)) {
    obs.push({
      source: "git",
      kind: "regression",
      summary: "Juno repo has uncommitted changes",
      score: 0.4,
    });
  }

  if (constitution) {
    const evidence = collectAmbitionEvidence(workbench, junoRepoRoot);
    for (const gap of computeAmbitionGaps(constitution, evidence)) {
      obs.push({
        source: "constitution",
        kind: "ambition_gap",
        summary: `${gap.ambitionId}: ${gap.openMetrics.map((m) => m.id).join(", ")} open`,
        score: Math.min(1, gap.gapScore),
        meta: { ambitionId: gap.ambitionId, open: gap.openMetrics.length },
      });
    }
  }

  return obs.sort((a, b) => b.score - a.score);
}

export function observationsToProposals(
  observations: DriveObservation[],
  constitution: JunoConstitution | null,
): DriveProposal[] {
  const proposals: DriveProposal[] = [];
  const threshold = constitution?.autoQueueThreshold ?? 0.55;
  const ts = new Date().toISOString();

  const has = (k: TensionKind) => observations.some((o) => o.kind === k && o.score >= threshold * 0.8);

  if (has("human_inbox")) {
    const inboxObs = observations.find((o) => o.kind === "human_inbox")!;
    proposals.push({
      id: `prop-inbox-${Date.now()}`,
      hypothesis: "Human left a brief in Vault inbox — highest priority override",
      tensionKinds: ["human_inbox"],
      score: 0.98,
      confidence: 0.95,
      needsHumanApproval: false,
      action: "compile_brief",
      briefText: readFileSync(inboxObs.meta!.path as string, "utf8"),
      createdAt: ts,
    });
  }

  if (has("research_gap")) {
    const started = observations.some((o) => o.summary.includes("in progress"));
    proposals.push({
      id: `prop-research-${Date.now()}`,
      hypothesis: started
        ? "Continue 100-paper agent drive research mission"
        : "Bootstrap 100-paper literature mission → synthesize curiosity/ambition architecture",
      tensionKinds: ["research_gap", "ambition_gap"],
      score: 0.88,
      confidence: 0.85,
      needsHumanApproval: false,
      action: "bootstrap",
      missionId: "juno-agent-drive-research-2026",
      bootstrap: "queue:agent-drive-research",
      createdAt: ts,
    });
  }

  if (has("hardware_opportunity")) {
    proposals.push({
      id: `prop-hw-${Date.now()}`,
      hypothesis: "Dev boards connected — enable serial-boards MCP and probe",
      tensionKinds: ["hardware_opportunity", "ambition_gap"],
      score: 0.72,
      confidence: 0.8,
      needsHumanApproval: false,
      action: "bootstrap",
      missionId: "juno-hardware-mcp-2026",
      bootstrap: "queue:hardware-mcp",
      createdAt: ts,
    });
  }

  if (has("queue_idle") && !has("research_gap") && !has("hardware_opportunity")) {
    proposals.push({
      id: `prop-explore-${Date.now()}`,
      hypothesis: "Idle with no queue — self-generate explore mission from constitution gaps",
      tensionKinds: ["queue_idle", "ambition_gap"],
      score: 0.6,
      confidence: 0.5,
      needsHumanApproval: false,
      action: "compile_brief",
      briefText:
        "Juno drive tick: scan environment, close highest ambition gap, write digest to Vault Juno/inbox/",
      createdAt: ts,
    });
  }

  return proposals.sort((a, b) => b.score - a.score);
}

export function writeDriveDigest(
  workbench: string,
  result: Omit<DriveTickResult, "digestPath">,
): string | undefined {
  const inbox = readVaultJunoInbox(workbench);
  if (!inbox) return undefined;
  mkdirSync(inbox, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const digestPath = path.join(inbox, `digest-${date}.md`);
  const lines = [
    `# Juno Drive Digest — ${date}`,
    "",
    `**Scanned**: ${result.scannedAt}`,
    "",
    "## Observations",
    ...result.observations.slice(0, 12).map((o) => `- [${o.kind}] (${o.score.toFixed(2)}) ${o.summary}`),
    "",
    "## Proposals",
    ...result.proposals.map(
      (p) =>
        `- **${p.hypothesis}** — score=${p.score.toFixed(2)} conf=${p.confidence.toFixed(2)}${p.missionId ? ` → \`${p.missionId}\`` : ""}`,
    ),
    "",
    result.topProposal
      ? `**Action taken**: ${result.queued ? "queued" : "digest only"} — ${result.topProposal.hypothesis}`
      : "**Action taken**: none (below threshold)",
    "",
    result.missionId ? `Mission: \`${result.missionId}\`` : "",
    "",
    "_Generated by drive-engine v1 — amend `config/constitution.json` to steer ambitions._",
    "",
  ];
  writeFileSync(digestPath, lines.join("\n"), "utf8");
  return digestPath;
}

export interface ExecuteDriveOpts {
  autoQueue?: boolean;
  minScore?: number;
}

export function runDriveTick(
  workbench: string,
  junoRepoRoot: string,
  opts: ExecuteDriveOpts = {},
): DriveTickResult {
  const constitution = loadConstitution(workbench);
  const observations = scanEnvironment(workbench, junoRepoRoot, constitution);
  const proposals = observationsToProposals(observations, constitution);
  const minScore = opts.minScore ?? constitution?.autoQueueThreshold ?? 0.55;
  const top = proposals.find((p) => p.score >= minScore && !p.needsHumanApproval) ?? null;

  const result: DriveTickResult = {
    scannedAt: new Date().toISOString(),
    observations,
    proposals,
    topProposal: top,
    queued: false,
  };

  if (opts.autoQueue && top) {
    if (top.action === "bootstrap" && top.bootstrap && top.missionId) {
      result.queued = true;
      result.missionId = top.missionId;
    } else if (top.action === "compile_brief" && top.briefText) {
      const plan = compileBriefFromText(top.briefText);
      writeBriefMission(workbench, plan);
      result.queued = true;
      result.missionId = plan.missionId;
    }
  }

  result.digestPath = writeDriveDigest(workbench, result);
  writeDriveState(workbench, {
    lastScanAt: result.scannedAt,
    lastProposalId: top?.id,
    lastObservations: observations.length,
    lastQueued: result.queued,
  });

  appendFileSync(
    path.join(workbench, "state", "drive-log.jsonl"),
    `${JSON.stringify({ ts: result.scannedAt, top: top?.id, score: top?.score, queued: result.queued, missionId: result.missionId })}\n`,
    "utf8",
  );

  return result;
}
