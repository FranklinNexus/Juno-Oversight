#!/usr/bin/env node
/** Strict CAS writer for AgentWorkbench queue/now.yaml bootstrap candidates. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadStrictQueueIo,
  replaceQueueSnapshotWithIo,
} from "./lib/queue-bootstrap.mjs";

function optionValue(args, name) {
  const indexes = args.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length > 1) throw new Error(`duplicate ${name}`);
  if (indexes.length === 0) return null;
  const value = args[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseArgs(args) {
  const flagsWithValues = new Set(["--json", "--yaml", "--out", "--backup-prefix"]);
  const flags = new Set(["--if-missing"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flagsWithValues.has(arg)) {
      index += 1;
      if (index >= args.length || args[index].startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
    } else if (!flags.has(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  const jsonPath = optionValue(args, "--json");
  const yamlPath = optionValue(args, "--yaml");
  if (Boolean(jsonPath) === Boolean(yamlPath)) {
    throw new Error("exactly one of --json or --yaml is required");
  }
  return {
    jsonPath,
    yamlPath,
    outPath: path.resolve(
      optionValue(args, "--out") ?? path.join("E:", "AgentWorkbench", "queue", "now.yaml"),
    ),
    backupPrefix: optionValue(args, "--backup-prefix"),
    onlyIfMissing: args.includes("--if-missing"),
  };
}

function workbenchForQueuePath(outPath) {
  const queueDir = path.dirname(outPath);
  if (
    path.basename(outPath).toLowerCase() !== "now.yaml" ||
    path.basename(queueDir).toLowerCase() !== "queue"
  ) {
    throw new Error("--out must be <workbench>/queue/now.yaml");
  }
  return path.dirname(queueDir);
}

function parseJsonCandidate(raw, source) {
  const payload = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  const unknown = Object.keys(payload).filter(
    (key) => !["updated", "now", "backlog"].includes(key),
  );
  if (unknown.length > 0) throw new Error(`${source} has unknown fields: ${unknown.join(", ")}`);
  if (!Array.isArray(payload.now) || !Array.isArray(payload.backlog)) {
    throw new Error(`${source} must contain now and backlog arrays`);
  }
  return { now: payload.now, backlog: payload.backlog };
}

export async function runWriteQueue(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const queueIo = await loadStrictQueueIo();
  const source = options.jsonPath ?? options.yamlPath;
  const raw = readFileSync(source, "utf8");
  const candidate = options.jsonPath
    ? parseJsonCandidate(raw, source)
    : queueIo.parseQueueDocument(raw.replace(/^\uFEFF/, ""), source);
  const workbench = workbenchForQueuePath(options.outPath);
  const result = replaceQueueSnapshotWithIo(queueIo, {
    workbench,
    ...candidate,
    backupPrefix: options.backupPrefix,
    onlyIfMissing: options.onlyIfMissing,
  });
  if (!result.changed) {
    process.stderr.write(`[juno] kept existing queue ${options.outPath} (${result.reason})\n`);
    return result;
  }
  process.stderr.write(
    `[juno] replaced ${options.outPath} (${candidate.now.length} now, ${candidate.backlog.length} backlog)` +
      `${result.backupPath ? `; backup: ${result.backupPath}` : ""}\n`,
  );
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await runWriteQueue();
  } catch (error) {
    process.stderr.write(`[juno] queue write blocked: ${error.message}\n`);
    process.exitCode = 1;
  }
}
