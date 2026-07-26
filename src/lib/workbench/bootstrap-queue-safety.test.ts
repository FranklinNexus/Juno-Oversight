import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as queueIo from "../../../orchestrator/src/queue-io";
import { replaceQueueSnapshotWithIo } from "../../../scripts/lib/queue-bootstrap.mjs";

function item(id: string) {
  return {
    id,
    horizon: "mission" as const,
    kind: "implement",
    run_kind: "implement" as const,
    repo_target: "juno-overseer" as const,
    mission_id: "bootstrap-test",
    phase_id: id,
    prompt: "executor_implement",
    provider: "openai_codex" as const,
    max_minutes: 5,
  };
}

function workbench(prefix: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  mkdirSync(path.join(root, "queue"), { recursive: true });
  return root;
}

function scriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return scriptFiles(target);
    return /\.(?:mjs|ps1)$/i.test(entry.name) ? [target] : [];
  });
}

describe("bootstrap queue safety", () => {
  it("fails closed when the live queue is malformed", () => {
    const root = workbench("juno-bootstrap-malformed-");
    const queuePath = path.join(root, "queue", "now.yaml");
    const malformed = "now: [\nbacklog: []\n";
    writeFileSync(queuePath, malformed, "utf8");

    expect(() =>
      replaceQueueSnapshotWithIo(queueIo, {
        workbench: root,
        now: [item("replacement")],
        backlog: [],
      }),
    ).toThrow(queueIo.QueueFileError);
    expect(readFileSync(queuePath, "utf8")).toBe(malformed);
  });

  it("does not overwrite a scheduler update made after the bootstrap read", () => {
    const root = workbench("juno-bootstrap-conflict-");
    queueIo.saveNowQueue(root, [item("original")]);

    const racingQueueIo = {
      ...queueIo,
      replaceQueueSnapshotConditional: (
        target: string,
        update: Parameters<typeof queueIo.replaceQueueSnapshotConditional>[1],
      ) => {
        queueIo.saveNowQueue(target, [item("scheduler-won")]);
        return queueIo.replaceQueueSnapshotConditional(target, update);
      },
    };

    expect(() =>
      replaceQueueSnapshotWithIo(racingQueueIo, {
        workbench: root,
        now: [item("bootstrap")],
        backlog: [],
      }),
    ).toThrow(/revision_conflict/);
    expect(queueIo.parseNowYaml(root).now.map((entry) => entry.id)).toEqual([
      "scheduler-won",
    ]);
  });

  it("captures the exact expected revision before replacing it", () => {
    const root = workbench("juno-bootstrap-backup-");
    queueIo.saveNowQueue(root, [item("before")]);
    const queuePath = path.join(root, "queue", "now.yaml");
    const before = readFileSync(queuePath, "utf8");

    const result = replaceQueueSnapshotWithIo(queueIo, {
      workbench: root,
      now: [item("after")],
      backlog: [],
      backupPrefix: "bak-test",
    });

    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeTruthy();
    expect(readFileSync(result.backupPath!, "utf8")).toBe(before);
    expect(queueIo.parseNowYaml(root).now[0]?.id).toBe("after");
  });

  it("keeps scaffold initialization from replacing an existing queue", () => {
    const root = workbench("juno-bootstrap-existing-");
    queueIo.saveNowQueue(root, [item("existing")]);
    const result = replaceQueueSnapshotWithIo(queueIo, {
      workbench: root,
      now: [item("scaffold")],
      backlog: [],
      onlyIfMissing: true,
    });

    expect(result).toMatchObject({ changed: false, reason: "queue_exists" });
    expect(queueIo.parseNowYaml(root).now[0]?.id).toBe("existing");
  });

  it("has no production script that writes queue/now.yaml outside strict queue-io", () => {
    const scriptsRoot = path.join(process.cwd(), "scripts");
    const offenders: string[] = [];
    const directMjsWrite =
      /(?:writeFileSync|appendFileSync|truncateSync|rmSync|unlinkSync)\s*\(\s*(?:queuePath|nowPath|path\.join\([^\n]{0,160}(?:queue|now\.yaml))/m;
    const directMjsRename =
      /renameSync\s*\([^\n]{0,200},\s*(?:queuePath|nowPath|path\.join\([^\n]{0,160}(?:queue|now\.yaml))/m;
    const directPsWrite =
      /(?:Set-Content|Add-Content|Out-File)[^\r\n]*(?:now\.yaml|\$nowPath)|WriteAllText\s*\(\s*(?:\(Join-Path[^\r\n]*now\.yaml|\$nowPath)/im;

    for (const file of scriptFiles(scriptsRoot)) {
      const source = readFileSync(file, "utf8");
      if (file.endsWith(".mjs") && (directMjsWrite.test(source) || directMjsRename.test(source))) {
        offenders.push(path.relative(process.cwd(), file));
      }
      if (file.endsWith(".ps1") && directPsWrite.test(source)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
