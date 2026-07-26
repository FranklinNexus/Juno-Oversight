import type { AgentProvider, RunManifest } from "./types.js";
import type { ExecutionAttemptBinding } from "./execution-artifact.js";

export interface AgentExecutionContext {
  manifest: RunManifest;
  workbench: string;
  runDir: string;
  prompt: string;
  attempt?: ExecutionAttemptBinding;
}

export interface AgentExecutionResult {
  ok: boolean;
  text: string;
}

export type AgentExecutor = (
  context: AgentExecutionContext,
) => Promise<AgentExecutionResult>;

export function resolveAgentExecutor(
  provider: AgentProvider,
  executors: Partial<Record<AgentProvider, AgentExecutor>>,
): AgentExecutor {
  const executor = executors[provider];
  if (executor) return executor;
  if (provider === "api_token") {
    throw new Error(
      "api_token is text-only and cannot execute Juno slots; use openai_codex",
    );
  }
  if (provider === "cursor_composer") {
    throw new Error(
      "cursor_composer is a legacy queue identifier; route it to openai_codex in model-defaults.json",
    );
  }
  throw new Error(`No agent executor registered for provider: ${provider}`);
}
