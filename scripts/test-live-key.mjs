import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Agent, CursorAgentError } = require("../orchestrator/node_modules/@cursor/sdk");

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    try {
      const text = readFileSync(path.join(projectRoot, name), "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = value;
      }
    } catch {
      // optional
    }
  }
}

loadEnv();

const apiKey = process.env.CURSOR_API_KEY?.trim();
if (!apiKey) {
  console.error("CURSOR_API_KEY missing — check .env.local");
  process.exit(1);
}

const workbench = process.env.AGENT_WORKBENCH_ROOT ?? "E:\\AgentWorkbench";

try {
  const result = await Agent.prompt(
    "You are running a Juno Overseer live-key smoke test. Reply with exactly one line: JUNO_LIVE_OK",
    {
      apiKey,
      model: { id: "composer-2.5" },
      local: { cwd: workbench, settingSources: [] },
    },
  );
  console.log("status:", result.status);
  console.log("result:", (result.result ?? "").slice(0, 400));
  if (result.status === "error") process.exitCode = 2;
} catch (err) {
  if (err instanceof CursorAgentError) {
    console.error("startup failed:", err.message, "retryable=", err.isRetryable);
    process.exit(1);
  }
  throw err;
}
