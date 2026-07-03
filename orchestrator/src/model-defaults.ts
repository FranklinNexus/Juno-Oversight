/**
 * Live model selection — fallback chain when primary model returns error.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ModelDefaultsConfig {
  /** Primary model for cursor_composer slots */
  cursorComposerDefault?: string;
  /** Try in order on retry or after primary fails at spawn layer */
  cursorComposerFallback?: string[];
}

export const DEFAULT_MODEL_DEFAULTS: ModelDefaultsConfig = {
  cursorComposerDefault: "auto",
  cursorComposerFallback: ["auto", "composer-2.5", "composer-2"],
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
      cursorComposerDefault: raw.cursorComposerDefault ?? DEFAULT_MODEL_DEFAULTS.cursorComposerDefault,
      cursorComposerFallback: raw.cursorComposerFallback?.length
        ? raw.cursorComposerFallback
        : DEFAULT_MODEL_DEFAULTS.cursorComposerFallback,
    };
  } catch {
    return { ...DEFAULT_MODEL_DEFAULTS };
  }
}

export function resolveComposerModel(workbench: string, override?: string): string {
  if (override?.trim()) return override.trim();
  return loadModelDefaults(workbench).cursorComposerDefault ?? "auto";
}

export function composerFallbackChain(workbench: string): string[] {
  const cfg = loadModelDefaults(workbench);
  const chain = [
    cfg.cursorComposerDefault ?? "auto",
    ...(cfg.cursorComposerFallback ?? DEFAULT_MODEL_DEFAULTS.cursorComposerFallback!),
  ];
  return [...new Set(chain.filter(Boolean))];
}
