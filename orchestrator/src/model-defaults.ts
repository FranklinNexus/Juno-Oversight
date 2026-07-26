/**
 * Live model selection — fallback chain when primary model returns error.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentProvider } from "./types.js";

export interface ModelDefaultsConfig {
  /** Provider used when a queue item does not specify one. */
  defaultProvider?: AgentProvider;
  /** Explicit migration/routing map for legacy queue providers. */
  providerAliases?: Partial<Record<AgentProvider, AgentProvider>>;
}

export const DEFAULT_MODEL_DEFAULTS: ModelDefaultsConfig = {
  defaultProvider: "openai_codex",
  providerAliases: { cursor_composer: "openai_codex" },
};

function configPath(workbench: string): string {
  return path.join(workbench, "config", "model-defaults.json");
}

export function loadModelDefaults(workbench: string): ModelDefaultsConfig {
  const p = configPath(workbench);
  if (!existsSync(p)) return { ...DEFAULT_MODEL_DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as ModelDefaultsConfig;
    return {
      defaultProvider: raw.defaultProvider ?? DEFAULT_MODEL_DEFAULTS.defaultProvider,
      providerAliases: {
        ...DEFAULT_MODEL_DEFAULTS.providerAliases,
        ...raw.providerAliases,
      },
    };
  } catch {
    return { ...DEFAULT_MODEL_DEFAULTS };
  }
}

function validProvider(value: unknown): value is AgentProvider {
  return value === "cursor_composer" || value === "openai_codex" || value === "api_token";
}

export function resolveAgentProvider(
  workbench: string,
  requested?: AgentProvider,
): AgentProvider {
  const config = loadModelDefaults(workbench);
  const fallback = config.defaultProvider;
  const selected = validProvider(requested)
    ? requested
    : validProvider(fallback) && fallback !== "api_token"
      ? fallback
      : "openai_codex";
  const aliased = config.providerAliases?.[selected];
  if (validProvider(aliased) && aliased !== "cursor_composer") return aliased;
  if (selected === "cursor_composer") return "openai_codex";
  return selected;
}

export function resolveAgentModel(
  provider: AgentProvider,
  requested?: string,
): string | undefined {
  const model = requested?.trim();
  if (!model) return undefined;
  if (
    provider === "openai_codex" &&
    (model.toLowerCase() === "auto" || /^composer(?:-|$)/i.test(model))
  ) {
    return undefined;
  }
  return model;
}
