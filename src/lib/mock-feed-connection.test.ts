import { beforeEach, describe, expect, it } from "vitest";
import {
  registerMockFeed,
  reportMockFeedLatency,
  resetMockFeedConnectionForTests,
  unregisterMockFeed,
} from "@/lib/mock-feed-connection";
import { useHudStore } from "@/store/hud-store";

describe("mock-feed-connection", () => {
  beforeEach(() => {
    resetMockFeedConnectionForTests();
  });

  it("stays connected while any instance is registered", () => {
    registerMockFeed("market:panel-a", 20);
    registerMockFeed("github:panel-b", 30);
    expect(useHudStore.getState().wsConnected).toBe(true);
    expect(useHudStore.getState().wsLatencyMs).toBe(30);

    unregisterMockFeed("market:panel-a");
    expect(useHudStore.getState().wsConnected).toBe(true);
    expect(useHudStore.getState().wsLatencyMs).toBe(30);

    unregisterMockFeed("github:panel-b");
    expect(useHudStore.getState().wsConnected).toBe(false);
  });

  it("supports multiple instances of the same feed type", () => {
    registerMockFeed("market:1", 10);
    registerMockFeed("market:2", 40);
    unregisterMockFeed("market:1");
    expect(useHudStore.getState().wsConnected).toBe(true);
    expect(useHudStore.getState().wsLatencyMs).toBe(40);
  });

  it("updates latency for active instances", () => {
    registerMockFeed("market:1", 10);
    reportMockFeedLatency("market:1", 55);
    expect(useHudStore.getState().wsLatencyMs).toBe(55);
  });
});
