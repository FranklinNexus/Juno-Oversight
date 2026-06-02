import { describe, expect, it } from "vitest";
import { formatPct, formatPrice, formatRam } from "@/lib/format";

describe("formatRam", () => {
  it("formats megabytes below 1GB", () => {
    expect(formatRam(512)).toBe("512M");
  });

  it("formats gigabytes with one decimal", () => {
    expect(formatRam(2048)).toBe("2.0G");
  });
});

describe("formatPrice", () => {
  it("uses two decimals for large values", () => {
    expect(formatPrice(68320.12)).toBe("68320.12");
  });
});

describe("formatPct", () => {
  it("prefixes positive values", () => {
    expect(formatPct(1.2)).toBe("+1.20%");
  });

  it("keeps negative sign", () => {
    expect(formatPct(-0.4)).toBe("-0.40%");
  });
});
