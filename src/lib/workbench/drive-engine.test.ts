import { describe, expect, it } from "vitest";
import { computeAmbitionGaps, loadConstitution } from "../../../orchestrator/src/constitution.js";
import {
  collectAmbitionEvidence,
  observationsToProposals,
  scanEnvironment,
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
});
