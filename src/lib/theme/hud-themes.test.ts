import { describe, expect, it } from "vitest";
import { nextHudTheme } from "@/lib/theme/hud-themes";

describe("nextHudTheme", () => {
  it("cycles night → saturn → day → night", () => {
    expect(nextHudTheme("night")).toBe("saturn");
    expect(nextHudTheme("saturn")).toBe("day");
    expect(nextHudTheme("day")).toBe("night");
  });
});
