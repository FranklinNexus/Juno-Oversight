import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  acquireApiSlot,
  estimateManifestTokens,
  estimateMissionCapacity,
  getQuotaStatus,
  loadApiLimits,
  reconcileStaleApiInflight,
  recordApiFailure,
  releaseApiSlot,
  resolveLimits,
  resolveProviderId,
  waitForApiSlot,
} from "../../../orchestrator/src/api-gateway.js";
import type { RunManifest } from "../../../orchestrator/src/types.js";

function wb(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "juno-api-gw-"));
  mkdirSync(path.join(dir, "config"), { recursive: true });
  mkdirSync(path.join(dir, "state"), { recursive: true });
  return dir;
}

describe("api-gateway", () => {
  it("resolves provider from manifest", () => {
    expect(
      resolveProviderId({ provider: "cursor_composer" } as RunManifest),
    ).toBe("cursor");
    expect(
      resolveProviderId({ provider: "api_token", providerRef: "openai" } as RunManifest),
    ).toBe("openai");
  });

  it("enforces min interval between cursor slots", () => {
    const dir = wb();
    const first = acquireApiSlot(dir, "cursor");
    expect(first.ok).toBe(true);
    const second = acquireApiSlot(dir, "cursor");
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("max_concurrent");
    releaseApiSlot(dir, "cursor");
    const third = acquireApiSlot(dir, "cursor");
    expect(third.ok).toBe(false);
    expect(third.reason).toBe("min_interval");
  });

  it("records backoff on 429", () => {
    const dir = wb();
    acquireApiSlot(dir, "cursor");
    releaseApiSlot(dir, "cursor");
    const fail = recordApiFailure(dir, "cursor", { httpStatus: 429, retryable: true });
    expect(fail.ok).toBe(false);
    expect(fail.waitMs).toBeGreaterThan(0);
    const blocked = acquireApiSlot(dir, "cursor");
    expect(blocked.reason).toBe("provider_backoff");
  });

  it("loads workbench api-limits.json overrides", () => {
    const dir = wb();
    writeFileSync(
      path.join(dir, "config", "api-limits.json"),
      JSON.stringify({ providers: { cursor: { maxRpm: 2 } } }),
      "utf8",
    );
    expect(resolveLimits(dir, "cursor").maxRpm).toBe(2);
    expect(loadApiLimits(dir).providers.cursor?.maxRpm).toBe(2);
  });

  it("estimates book mission capacity", () => {
    const dir = wb();
    writeFileSync(
      path.join(dir, "config", "api-limits.json"),
      JSON.stringify({
        missions: {
          "juno-axiom-book-2026": { estimatedLiveSlots: 42, estimatedTokensPerSlot: 26000 },
        },
      }),
      "utf8",
    );
    const cap = estimateMissionCapacity(dir, "juno-axiom-book-2026");
    expect(cap?.totalTokens).toBe(42 * 26000);
  });

  it(
    "waitForApiSlot eventually acquires after min interval",
    async () => {
      const dir = wb();
      writeFileSync(
        path.join(dir, "config", "api-limits.json"),
        JSON.stringify({ providers: { cursor: { minIntervalMs: 150 } } }),
        "utf8",
      );
      acquireApiSlot(dir, "cursor");
      releaseApiSlot(dir, "cursor");
      const limits = resolveLimits(dir, "cursor");
      await new Promise((r) => setTimeout(r, limits.minIntervalMs + 50));
      const r = await waitForApiSlot(dir, "cursor", { maxWaitMs: 3000 });
      expect(r.ok).toBe(true);
      releaseApiSlot(dir, "cursor");
    },
    10_000,
  );

  it("estimates chapter write tokens higher than review", () => {
    const write: RunManifest = {
      provider: "cursor_composer",
      runKind: "implement",
      phaseId: "ax03-ch01-write",
    } as RunManifest;
    const review: RunManifest = {
      provider: "cursor_composer",
      runKind: "review",
      phaseId: "ax04-ch01-review",
    } as RunManifest;
    expect(estimateManifestTokens(write)).toBeGreaterThan(estimateManifestTokens(review));
  });

  it("getQuotaStatus returns cursor row", () => {
    const dir = wb();
    acquireApiSlot(dir, "cursor", { estimatedTokens: 1000 });
    releaseApiSlot(dir, "cursor");
    const rows = getQuotaStatus(dir);
    expect(rows.some((r) => r.providerId === "cursor" && r.dailyRequests >= 1)).toBe(true);
  });

  it("reconcileStaleApiInflight clears orphaned inflight when orchestrator idle", () => {
    const dir = wb();
    acquireApiSlot(dir, "cursor");
    const cleared = reconcileStaleApiInflight(dir);
    expect(cleared).toBe(1);
    const rows = getQuotaStatus(dir);
    expect(rows.find((r) => r.providerId === "cursor")?.inflight).toBe(0);
  });
});
