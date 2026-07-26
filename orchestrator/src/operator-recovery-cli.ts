import { readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOperatorRecovery,
  inspectOperatorRecovery,
  type ApplyOperatorRecoveryInput,
} from "./operator-recovery.js";

const MAX_STDIN_BYTES = 4 * 1024;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseOperatorRecoveryMode(argv: string[]): "inspect" | "apply" {
  if (argv.length !== 1 || (argv[0] !== "inspect" && argv[0] !== "apply")) {
    throw new Error("Operator recovery CLI requires exactly one mode: inspect or apply");
  }
  return argv[0];
}

export function parseOperatorRecoveryApplyInput(text: string): ApplyOperatorRecoveryInput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("Operator recovery apply input must be valid JSON", { cause: error });
  }
  if (!isRecord(value)) throw new Error("Operator recovery apply input must be an object");
  const keys = Object.keys(value).sort();
  const expected = ["action", "incidentId", "preconditionSha256", "reason"];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error("Operator recovery apply input has missing or unknown fields");
  }
  if (!SHA256.test(String(value.incidentId)) || !SHA256.test(String(value.preconditionSha256))) {
    throw new Error("Operator recovery fingerprints must be lowercase SHA-256 values");
  }
  if (value.action !== "resume_exact_intent") {
    throw new Error("Operator recovery action must be resume_exact_intent");
  }
  if (
    typeof value.reason !== "string" ||
    value.reason.length < 1 ||
    value.reason.length > 500 ||
    value.reason !== value.reason.trim() ||
    /[\u0000-\u001f\u007f]/.test(value.reason)
  ) {
    throw new Error("Operator recovery reason must be trimmed, non-empty, and at most 500 characters");
  }
  return value as unknown as ApplyOperatorRecoveryInput;
}

function readBoundedStdin(): string {
  const buffer = Buffer.alloc(MAX_STDIN_BYTES + 1);
  let byteLength = 0;
  while (byteLength < buffer.length) {
    const count = readSync(0, buffer, byteLength, buffer.length - byteLength, null);
    if (count === 0) break;
    byteLength += count;
  }
  if (byteLength === 0) throw new Error("Operator recovery apply input is empty");
  if (byteLength > MAX_STDIN_BYTES) {
    throw new Error(`Operator recovery apply input exceeds ${MAX_STDIN_BYTES} bytes`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, byteLength));
  } catch (error) {
    throw new Error("Operator recovery apply input must be valid UTF-8", { cause: error });
  }
}

function workbenchFromEnvironment(environment: NodeJS.ProcessEnv): string {
  const workbench = environment.AGENT_WORKBENCH_ROOT?.trim();
  if (!workbench || workbench.includes("\0")) {
    throw new Error("AGENT_WORKBENCH_ROOT is not configured for operator recovery");
  }
  return workbench;
}

function writeJson(value: unknown): void {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_STDOUT_BYTES) {
    throw new Error(`Operator recovery output exceeds ${MAX_STDOUT_BYTES} bytes`);
  }
  process.stdout.write(text);
}

export function runOperatorRecoveryCli(
  argv = process.argv.slice(2),
  environment = process.env,
): void {
  const mode = parseOperatorRecoveryMode(argv);
  const workbench = workbenchFromEnvironment(environment);
  if (mode === "inspect") {
    writeJson(inspectOperatorRecovery(workbench));
    return;
  }
  const input = parseOperatorRecoveryApplyInput(readBoundedStdin());
  writeJson(applyOperatorRecovery(workbench, input));
}

function isMainModule(): boolean {
  return Boolean(
    process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)),
  );
}

if (isMainModule()) {
  try {
    runOperatorRecoveryCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message.slice(0, MAX_STDERR_BYTES - 1)}\n`);
    process.exitCode = 1;
  }
}
