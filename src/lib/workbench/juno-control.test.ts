import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyMissionSnapshot,
  parseMissionYaml,
  parseQueueYaml,
  readControlSnapshot,
  waitForMission,
} from "../../../scripts/lib/juno-control-core.mjs";

function fixture() {
  const workbench = mkdtempSync(path.join(os.tmpdir(), "juno-control-"));
  mkdirSync(path.join(workbench, "state"), { recursive: true });
  mkdirSync(path.join(workbench, "queue"), { recursive: true });
  mkdirSync(path.join(workbench, "missions", "mission-1"), { recursive: true });
  mkdirSync(path.join(workbench, "runs", "mission-1-p03-review"), { recursive: true });
  mkdirSync(path.join(workbench, "runs", "mission-1-p04-verify"), { recursive: true });
  return workbench;
}

const completedMission = `id: "mission-1"
status: COMPLETE
phases:
  - id: p01-plan
    status: done
  - id: p02-implement
    status: done
  - id: p03-review
    status: done
  - id: p04-verify
    status: done
`;

describe("juno-control core", () => {
  it("parses mission and queue state", () => {
    expect(parseMissionYaml(completedMission)).toEqual({
      missionStatus: "COMPLETE",
      phases: [
        { id: "p01-plan", status: "done" },
        { id: "p02-implement", status: "done" },
        { id: "p03-review", status: "done" },
        { id: "p04-verify", status: "done" },
      ],
    });
    expect(
      parseQueueYaml(
        "now:\n  - id: task-1\n    mission_id: mission-1\n    phase_id: p01-plan\nbacklog:\n  []\n",
      ).now,
    ).toEqual([{ id: "task-1", missionId: "mission-1", phaseId: "p01-plan" }]);
  });

  it("reports a completed four-phase mission with both gates passed", () => {
    const workbench = fixture();
    try {
      writeFileSync(
        path.join(workbench, "missions", "mission-1", "mission.yaml"),
        completedMission,
      );
      writeFileSync(
        path.join(workbench, "runs", "mission-1-p03-review", "checkpoint.md"),
        "## REVIEW_VERDICT\n- verdict: PASS\n",
      );
      writeFileSync(
        path.join(workbench, "runs", "mission-1-p04-verify", "checkpoint.md"),
        "## VERIFY_REPORT\n- tests: PASS\n",
      );
      writeFileSync(path.join(workbench, "queue", "now.yaml"), "now:\n  []\nbacklog:\n  []\n");
      writeFileSync(
        path.join(workbench, "state", "orchestrator.json"),
        JSON.stringify({ activeRunId: null, activeRunStatus: "idle" }),
      );
      writeFileSync(
        path.join(workbench, "state", "scheduler.json"),
        JSON.stringify({ enabled: true, lastAction: "queue_empty" }),
      );
      writeFileSync(path.join(workbench, "state", "daemon.pid"), "1234");

      const snapshot = readControlSnapshot(workbench, "mission-1", {
        pidChecker: (pid: number) => pid === 1234,
      });
      expect(snapshot).toMatchObject({
        missionStatus: "COMPLETE",
        phaseDone: 4,
        phaseTotal: 4,
        currentPhaseId: null,
        gates: { review: "PASS", verify: "PASS" },
        complete: true,
        queueDepth: 0,
        schedulerRunning: true,
        schedulerPid: 1234,
        workerRunning: false,
      });
      expect(classifyMissionSnapshot(snapshot)).toBe("complete");
    } finally {
      rmSync(workbench, { recursive: true, force: true });
    }
  });

  it("does not trust stale daemon or worker pid files", () => {
    const workbench = fixture();
    try {
      writeFileSync(
        path.join(workbench, "missions", "mission-1", "mission.yaml"),
        completedMission.replace("COMPLETE", "ACTIVE").replaceAll("status: done", "status: queued"),
      );
      writeFileSync(path.join(workbench, "queue", "now.yaml"), "now:\n  []\nbacklog:\n  []\n");
      writeFileSync(
        path.join(workbench, "state", "orchestrator.json"),
        JSON.stringify({
          activeRunId: "mission-1-p01-plan",
          activeRunStatus: "blocked",
          activeWorkerPid: 9999,
        }),
      );
      writeFileSync(path.join(workbench, "state", "daemon.pid"), "8888");

      const snapshot = readControlSnapshot(workbench, "mission-1", {
        pidChecker: () => false,
      });
      expect(snapshot.schedulerRunning).toBe(false);
      expect(snapshot.schedulerPid).toBeNull();
      expect(snapshot.workerPid).toBeNull();
      expect(snapshot.blocked).toBe(true);
      expect(classifyMissionSnapshot(snapshot)).toBe("blocked");
    } finally {
      rmSync(workbench, { recursive: true, force: true });
    }
  });

  it("keeps a retryable worker failure non-terminal", () => {
    const workbench = fixture();
    try {
      writeFileSync(
        path.join(workbench, "missions", "mission-1", "mission.yaml"),
        completedMission.replace("COMPLETE", "ACTIVE").replaceAll("status: done", "status: queued"),
      );
      writeFileSync(path.join(workbench, "queue", "now.yaml"), "now:\n  []\nbacklog:\n  []\n");
      mkdirSync(path.join(workbench, "runs", "mission-1-p01-plan"), { recursive: true });
      writeFileSync(
        path.join(workbench, "runs", "mission-1-p01-plan", "run-state.json"),
        JSON.stringify({ retryCount: 1, maxRetries: 3, lastStatus: "failed" }),
      );
      writeFileSync(
        path.join(workbench, "state", "orchestrator.json"),
        JSON.stringify({
          activeRunId: "mission-1-p01-plan",
          activeRunStatus: "failed",
        }),
      );
      writeFileSync(path.join(workbench, "state", "daemon.pid"), "1234");

      const snapshot = readControlSnapshot(workbench, "mission-1", {
        pidChecker: (pid: number) => pid === 1234,
      });
      expect(snapshot.failed).toBe(false);
      expect(snapshot.retryExhausted).toBe(false);
      expect(classifyMissionSnapshot(snapshot)).toBe("running");
    } finally {
      rmSync(workbench, { recursive: true, force: true });
    }
  });

  it("returns a deterministic timeout", async () => {
    let clock = 0;
    const running = {
      missionExists: true,
      complete: false,
      blocked: false,
      failed: false,
    };
    const result = await waitForMission({
      workbench: "unused",
      missionId: "mission-1",
      timeoutMs: 100,
      pollMs: 50,
      snapshotReader: () => running,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    });
    expect(result).toMatchObject({ outcome: "timeout", timedOut: true, durationMs: 100 });
  });

  it("keeps status stdout to one machine-readable JSON document", () => {
    const workbench = fixture();
    try {
      writeFileSync(path.join(workbench, "queue", "now.yaml"), "now:\n  []\nbacklog:\n  []\n");
      const result = spawnSync(
        process.execPath,
        [path.join(process.cwd(), "scripts", "juno-control.mjs"), "status", "--mission", "missing"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench },
        },
      );
      const lines = result.stdout.trim().split(/\r?\n/);
      expect(result.status).toBe(0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        ok: true,
        command: "status",
        missionId: "missing",
        missionStatus: "MISSING",
      });
    } finally {
      rmSync(workbench, { recursive: true, force: true });
    }
  });

  it("wait resumes a paused live scheduler before observing the mission", () => {
    const workbench = fixture();
    try {
      writeFileSync(path.join(workbench, "queue", "now.yaml"), "now:\n  []\nbacklog:\n  []\n");
      writeFileSync(
        path.join(workbench, "state", "scheduler.json"),
        JSON.stringify({ enabled: false }),
      );
      writeFileSync(path.join(workbench, "state", "daemon.pid"), String(process.pid));
      const result = spawnSync(
        process.execPath,
        [
          path.join(process.cwd(), "scripts", "juno-control.mjs"),
          "wait",
          "--mission",
          "missing",
          "--timeout-ms",
          "100",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, AGENT_WORKBENCH_ROOT: workbench },
        },
      );
      const output = JSON.parse(result.stdout);
      const scheduler = JSON.parse(
        readFileSync(path.join(workbench, "state", "scheduler.json"), "utf8"),
      );
      expect(result.status).toBe(5);
      expect(output).toMatchObject({ ok: false, command: "wait", outcome: "missing" });
      expect(scheduler.enabled).toBe(true);
    } finally {
      rmSync(workbench, { recursive: true, force: true });
    }
  });
});
