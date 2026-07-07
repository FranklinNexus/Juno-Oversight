#!/usr/bin/env node
/**
 * Vault bridge tick — inbox + brief ingest, status board, constitution check.
 * Slot outcomes are logged by mission-loop via recordSlotOutcome().
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runVaultBridgeTick } from "./lib/vault-bridge-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

const result = runVaultBridgeTick(workbench, repoRoot);
if (result.ingested > 0) {
  process.stderr.write(`[vault-bridge] ingested ${result.ingested} item(s)\n`);
}
