#!/usr/bin/env node
/**
 * Vault bridge tick — ingest inbox missions only.
 * Slot outcomes are logged by mission-loop via recordSlotOutcome().
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncInboxIngest } from "./lib/vault-bridge-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

const result = syncInboxIngest(workbench, repoRoot);
if (result.ingested > 0) {
  process.stderr.write(`[vault-bridge] ingested ${result.ingested} mission(s)\n`);
}
