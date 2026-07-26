#!/usr/bin/env node
/**
 * App Router projects must not serve stale pages/_document from .next/dev.
 * Obsidian sync / interrupted dev leaves _document.js without [turbopack]_runtime.js → HTTP 500.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function hasUserPagesRouter() {
  return (
    existsSync(path.join(root, "pages")) || existsSync(path.join(root, "src/pages"))
  );
}

/** @returns {{ corrupt: boolean; reason?: string }} */
export function inspectDevCache() {
  if (hasUserPagesRouter()) return { corrupt: false };

  const nextDir = path.join(root, ".next");
  const devDir = path.join(nextDir, "dev");
  if (!existsSync(devDir)) return { corrupt: false };

  const staleDocument = path.join(devDir, "server/pages/_document.js");
  const turbopackRuntime = path.join(devDir, "server/chunks/ssr/[turbopack]_runtime.js");

  if (existsSync(staleDocument) && !existsSync(turbopackRuntime)) {
    return {
      corrupt: true,
      reason: "pages/_document.js without [turbopack]_runtime.js",
    };
  }

  if (existsSync(staleDocument)) {
    try {
      const text = readFileSync(staleDocument, "utf8");
      if (text.includes("[turbopack]_runtime.js") && !existsSync(turbopackRuntime)) {
        return { corrupt: true, reason: "broken Turbopack runtime reference in _document.js" };
      }
    } catch {
      /* ignore */
    }
  }

  return { corrupt: false };
}

export function repairDevCache({ quiet = false } = {}) {
  const { corrupt, reason } = inspectDevCache();
  if (!corrupt) return false;

  if (!quiet) {
    process.stderr.write(
      `[juno] removing stale .next/dev cache (${reason ?? "corrupt"}) — run pnpm dev again\n`,
    );
  }
  rmSync(path.join(root, ".next"), { recursive: true, force: true });
  return true;
}

if (process.argv[1]?.endsWith("check-dev-cache.mjs")) {
  const { corrupt, reason } = inspectDevCache();
  if (corrupt) {
    process.stderr.write(`[juno] dev cache corrupt: ${reason}\n`);
    process.exit(1);
  }
  process.stderr.write("[juno] dev cache OK\n");
}
