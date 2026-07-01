import { describe, expect, it } from "vitest";
import {
  handoffEvent,
  isJunoEvent,
  parseEventLine,
  reflexionEvent,
  verdictEvent,
} from "../../../orchestrator/src/events-schema.js";

describe("events-schema", () => {
  it("parses handoff and verdict events", () => {
    const h = handoffEvent("implement", "review", "slot complete");
    const line = JSON.stringify(h);
    expect(parseEventLine(line)).toEqual(h);
    expect(isJunoEvent(h)).toBe(true);
  });

  it("parses reflexion event", () => {
    const r = reflexionEvent("REVISE", "fix queue-io CRLF");
    expect(isJunoEvent(r)).toBe(true);
  });

  it("rejects invalid events", () => {
    expect(isJunoEvent({ ts: "x", type: "unknown" })).toBe(false);
    expect(parseEventLine("{bad json")).toBeNull();
  });

  it("verdict event carries PASS", () => {
    const v = verdictEvent("PASS", "scope ok");
    expect(v.type).toBe("verdict");
    if (v.type === "verdict") expect(v.verdict).toBe("PASS");
  });
});
