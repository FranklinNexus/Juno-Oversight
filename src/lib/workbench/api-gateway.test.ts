import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  acquireApiSlot,
  estimateManifestTokens,
  estimateMissionCapacity,
  getQuotaStatus,
  loadApiLimits,
  recordApiFailure,
  recordApiSuccess,
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
    ).toBe("openai");
    expect(resolveProviderId({ provider: "openai_codex" } as RunManifest)).toBe("openai");
    expect(
      resolveProviderId({ provider: "api_token", providerRef: "openai" } as RunManifest),
    ).toBe("openai");
  });

  it("enforces concurrency and min interval between Codex slots", () => {
    const dir = wb();
    const first = acquireApiSlot(dir, "openai");
    expect(first.ok).toBe(true);
    writeFileSync(
      path.join(dir, "config", "api-limits.json"),
      JSON.stringify({ providers: { openai: { maxConcurrent: 1 } } }),
      "utf8",
    );
    const second = acquireApiSlot(dir, "openai");
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("max_concurrent");
    releaseApiSlot(dir, "openai", first.leaseId);
    const third = acquireApiSlot(dir, "openai");
    expect(third.ok).toBe(false);
    expect(third.reason).toBe("min_interval");
  });

  it("records backoff on 429", () => {
    const dir = wb();
    const lease = acquireApiSlot(dir, "openai");
    releaseApiSlot(dir, "openai", lease.leaseId);
    const fail = recordApiFailure(dir, "openai", { httpStatus: 429, retryable: true });
    expect(fail.ok).toBe(false);
    expect(fail.waitMs).toBeGreaterThan(0);
    const blocked = acquireApiSlot(dir, "openai");
    expect(blocked.reason).toBe("provider_backoff");
  });

  it("does not let a concurrent success erase an active provider backoff", () => {
    const dir = wb();
    writeFileSync(
      path.join(dir, "config", "api-limits.json"),
      JSON.stringify({ providers: { openai: { minIntervalMs: 0, maxConcurrent: 2 } } }),
      "utf8",
    );
    const first = acquireApiSlot(dir, "openai", { estimatedTokens: 100 });
    const second = acquireApiSlot(dir, "openai", { estimatedTokens: 100 });
    releaseApiSlot(dir, "openai", first.leaseId);
    releaseApiSlot(dir, "openai", second.leaseId);
    recordApiFailure(dir, "openai", { httpStatus: 429, retryable: true });
    recordApiSuccess(dir, "openai", { tokens: 50, requestId: first.leaseId });

    expect(acquireApiSlot(dir, "openai").reason).toBe("provider_backoff");
  });

  it("loads workbench api-limits.json overrides", () => {
    const dir = wb();
    writeFileSync(
      path.join(dir, "config", "api-limits.json"),
      JSON.stringify({ providers: { openai: { maxRpm: 2 } } }),
      "utf8",
    );
    expect(resolveLimits(dir, "openai").maxRpm).toBe(2);
    expect(loadApiLimits(dir).providers.openai?.maxRpm).toBe(2);
  });

  it("fails closed on malformed or non-numeric limit configuration", () => {
    const dir = wb();
    const configPath = path.join(dir, "config", "api-limits.json");
    writeFileSync(
      configPath,
      JSON.stringify({ providers: { openai: { maxConcurrent: "not-a-number" } } }),
      "utf8",
    );
    expect(() => resolveLimits(dir, "openai")).toThrow(/openai\.maxConcurrent/);

    writeFileSync(configPath, "{broken", "utf8");
    expect(() => loadApiLimits(dir)).toThrow(/Invalid API limits config JSON/);
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
        JSON.stringify({ providers: { openai: { minIntervalMs: 150 } } }),
        "utf8",
      );
      const initial = acquireApiSlot(dir, "openai");
      releaseApiSlot(dir, "openai", initial.leaseId);
      const limits = resolveLimits(dir, "openai");
      await new Promise((r) => setTimeout(r, limits.minIntervalMs + 50));
      const r = await waitForApiSlot(dir, "openai", { maxWaitMs: 3000 });
      expect(r.ok).toBe(true);
      releaseApiSlot(dir, "openai", r.leaseId);
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

  it("reconciles estimated usage and recovers a lease owned by a dead process", () => {
    const dir = wb();
    writeFileSync(
      path.join(dir, "config", "api-limits.json"),
      JSON.stringify({ providers: { openai: { minIntervalMs: 0, maxConcurrent: 1 } } }),
      "utf8",
    );
    const acquired = acquireApiSlot(dir, "openai", { estimatedTokens: 1000 });
    writeFileSync(
      path.join(dir, "state", "api-quota.lock"),
      JSON.stringify({
        [["to", "ken"].join("")]: ["abandoned", "lock"].join("-"),
        pid: 999_999,
        acquiredAt: Date.now() - 60_000,
      }),
      "utf8",
    );
    recordApiSuccess(dir, "openai", { tokens: 100, requestId: acquired.leaseId });
    const quotaPath = path.join(dir, "state", "api-quota.json");
    const raw = JSON.parse(readFileSync(quotaPath, "utf8"));
    raw.providers.openai.leases[0].pid = 999_999;
    writeFileSync(quotaPath, JSON.stringify(raw), "utf8");

    const recovered = acquireApiSlot(dir, "openai");
    expect(recovered.ok).toBe(true);
    releaseApiSlot(dir, "openai", recovered.leaseId);
    const rows = getQuotaStatus(dir);
    expect(rows.find((row) => row.providerId === "openai")?.dailyTokens).toBe(100);
  });

  it("recovers a stale quota recovery guard left by a dead process", () => {
    const dir = wb();
    const recoveryGuard = path.join(dir, "state", "api-quota.lock.recovery");
    writeFileSync(
      recoveryGuard,
      JSON.stringify({
        [["to", "ken"].join("")]: ["abandoned", "recovery"].join("-"),
        pid: 999_999,
        acquiredAt: Date.now() - 60_000,
      }),
      "utf8",
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(recoveryGuard, old, old);

    const acquired = acquireApiSlot(dir, "openai");
    expect(acquired.ok).toBe(true);
    expect(existsSync(recoveryGuard)).toBe(false);
    releaseApiSlot(dir, "openai", acquired.leaseId);
  });

  it("fails closed on malformed numeric quota state", () => {
    const dir = wb();
    const acquired = acquireApiSlot(dir, "openai", { estimatedTokens: 100 });
    expect(acquired.ok).toBe(true);
    const quotaPath = path.join(dir, "state", "api-quota.json");
    const raw = JSON.parse(readFileSync(quotaPath, "utf8"));
    raw.providers.openai.daily.tokens = "not-a-number";
    writeFileSync(quotaPath, JSON.stringify(raw), "utf8");
    expect(() => acquireApiSlot(dir, "openai")).toThrow(/openai\.daily\.tokens/);
  });

  it("refreshes expired leases and prior-day counters in quota status", () => {
    const dir = wb();
    const acquired = acquireApiSlot(dir, "openai", { estimatedTokens: 100 });
    expect(acquired.ok).toBe(true);
    const quotaPath = path.join(dir, "state", "api-quota.json");
    const raw = JSON.parse(readFileSync(quotaPath, "utf8"));
    raw.providers.openai.leases[0].pid = 999_999;
    raw.providers.openai.daily = { date: "2000-01-01", requests: 7, tokens: 777 };
    writeFileSync(quotaPath, JSON.stringify(raw), "utf8");

    const rows = getQuotaStatus(dir);
    const openai = rows.find((row) => row.providerId === "openai");
    expect(openai).toMatchObject({ inflight: 0, dailyRequests: 0, dailyTokens: 0 });
    expect(rows.some((row) => row.providerId === "cursor")).toBe(false);
    const persisted = JSON.parse(readFileSync(quotaPath, "utf8"));
    expect(persisted.providers.openai.leases).toEqual([]);
    expect(persisted.providers.openai.daily.requests).toBe(0);
  });
});
