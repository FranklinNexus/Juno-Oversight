#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Codex } from "../orchestrator/node_modules/@openai/codex-sdk/dist/index.js";
import { buildCodexEnvironment } from "../orchestrator/dist/codex-executor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const controller = new AbortController();
const timeout = setTimeout(
  () => controller.abort(new Error("Codex login probe timed out")),
  120_000,
);

try {
  const codex = new Codex({ env: buildCodexEnvironment() });
  const thread = codex.startThread({
    sandboxMode: "read-only",
    workingDirectory: projectRoot,
    skipGitRepoCheck: true,
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
  });
  const result = await thread.run(
    "This is a Juno Codex login probe. Do not use tools. Reply with exactly: JUNO_CODEX_READY",
    { signal: controller.signal },
  );
  if (result.finalResponse.trim() !== "JUNO_CODEX_READY") {
    throw new Error(`Unexpected Codex response: ${result.finalResponse.slice(0, 400)}`);
  }
  console.log(`JUNO_CODEX_READY thread=${thread.id ?? "unknown"}`);
} finally {
  clearTimeout(timeout);
}
