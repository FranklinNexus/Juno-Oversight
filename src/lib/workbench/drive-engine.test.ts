import { describe, expect, it } from "vitest";
import { computeAmbitionGaps, loadConstitution } from "../../../orchestrator/src/constitution.js";
import {
  collectAmbitionEvidence,
  observationsToProposals,
  scanEnvironment,
  type DriveObservation,
} from "../../../orchestrator/src/drive-engine.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("constitution", () => {
  it("computes ambition gaps from metrics", () => {
    const gaps = computeAmbitionGaps(
      {
        ambitions: [
          {
            id: "agent-mind",
            statement: "test",
            weight: 1,
            metrics: [{ id: "a", description: "x" }, { id: "b", description: "y", satisfied: true }],
          },
        ],
      },
      {},
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0].openMetrics).toHaveLength(1);
  });
});

describe("drive-engine", () => {
  it("proposes research mission when gap detected", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "juno-drive-"));
    mkdirSync(path.join(dir, "config"), { recursive: true });
    mkdirSync(path.join(dir, "queue"), { recursive: true });
    writeFileSync(
      path.join(dir, "config", "constitution.json"),
      JSON.stringify({
        autoQueueThreshold: 0.5,
        ambitions: [{ id: "agent-mind", statement: "s", weight: 1, metrics: [{ id: "papers_100", description: "p" }] }],
      }),
    );
    writeFileSync(path.join(dir, "queue", "now.yaml"), "updated: x\nnow:\nbacklog: []\n");

    const obs = scanEnvironment(dir, process.cwd(), loadConstitution(dir));
    expect(obs.some((o) => o.kind === "research_gap")).toBe(true);

    const proposals = observationsToProposals(obs, loadConstitution(dir));
    expect(proposals.some((p) => p.missionId === "juno-agent-drive-research-2026")).toBe(true);
  });

  it("collects hardware evidence", () => {
    const ev = collectAmbitionEvidence(process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench", process.cwd());
    expect(ev["hardware-sovereignty:ports_scanned"]).toBeDefined();
  });

  it("prioritizes mission inbox pending items", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "juno-drive-inbox-"));
    const vault = mkdtempSync(path.join(tmpdir(), "juno-vault-"));
    mkdirSync(path.join(dir, "queue"), { recursive: true });
    mkdirSync(path.join(vault, "Juno"), { recursive: true });
    writeFileSync(
      path.join(dir, "config.yaml"),
      `vault_path: "${vault.replace(/\\/g, "/")}"\nvault_juno_root: "Juno"\n`,
    );
    writeFileSync(path.join(dir, "queue", "now.yaml"), "updated: x\nnow:\nbacklog: []\n");
    writeFileSync(path.join(vault, "Juno", "Juno_Mission_Inbox.md"), "- [ ] do something\n");
    const obs = scanEnvironment(dir, process.cwd(), null);
    const hit = obs.find((o) => o.summary.includes("Mission Inbox pending"));
    expect(hit?.kind).toBe("human_inbox");
  });

  it("ignores generated daily inbox files as human override", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "juno-drive-daily-"));
    const vault = mkdtempSync(path.join(tmpdir(), "juno-vault-"));
    const inboxDir = path.join(vault, "Juno", "inbox");
    mkdirSync(path.join(dir, "queue"), { recursive: true });
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.yaml"),
      `vault_path: "${vault.replace(/\\/g, "/")}"\nvault_juno_root: "Juno"\n`,
    );
    writeFileSync(path.join(dir, "queue", "now.yaml"), "updated: x\nnow:\nbacklog: []\n");
    writeFileSync(path.join(inboxDir, "2026-07-07-每日任务.md"), "# daily");
    const obs = scanEnvironment(dir, process.cwd(), null);
    expect(obs.some((o) => o.summary.includes("Human inbox file: 2026-07-07-每日任务.md"))).toBe(false);
  });

  it("does not crash on mission-inbox human_inbox without path", () => {
    const obs: DriveObservation[] = [
      { source: "vault", kind: "human_inbox", summary: "Mission Inbox pending: 1 item(s)", score: 0.99 },
    ];
    const proposals = observationsToProposals(obs, null);
    expect(proposals.length).toBeGreaterThanOrEqual(0);
  });

  it("strategy lrif promotes daily-inbox mission", () => {
    const obs: DriveObservation[] = [
      { source: "founder", kind: "founder_alignment", summary: "investment", score: 0.8 },
    ];
    const proposals = observationsToProposals(obs, null, {
      loadedAt: new Date().toISOString(),
      currentFocus: ["投资研究 LRIF"],
      ambitionText: "",
      themes: [],
      activeThemes: [],
      recentNotes: [],
      alignmentSummary: [],
      driveStrategy: "lrif",
    });
    expect(proposals[0]?.missionId).toBe("juno-daily-inbox-2026");
  });

  it("strategy wisdomechoes injects explicit route proposal", () => {
    const proposals = observationsToProposals([], null, {
      loadedAt: new Date().toISOString(),
      currentFocus: ["Juno Runtime 产品化"],
      ambitionText: "",
      themes: [],
      activeThemes: [],
      recentNotes: [],
      alignmentSummary: [],
      driveStrategy: "wisdomechoes",
    });
    expect(proposals[0]?.missionId).toBe("juno-wisdomechoes-axiom-blog-2026");
  });
});
