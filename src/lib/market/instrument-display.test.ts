import { describe, expect, it } from "vitest";
import { formatInstrumentDisplay } from "@/lib/market/instrument-display";

describe("formatInstrumentDisplay", () => {
  it("formats HK with 5-digit code and localized name", () => {
    const d = formatInstrumentDisplay("0700.HK", "hk");
    expect(d.code).toBe("00700");
    expect(d.suffix).toBe("HK");
    expect(d.name).toBe("腾讯控股");
    expect(d.fiatLabel).toBe("HKD");
  });

  it("formats A-share with exchange suffix", () => {
    const sh = formatInstrumentDisplay("600519.SS", "cn_a");
    expect(sh.code).toBe("600519");
    expect(sh.suffix).toBe("SH");
    expect(sh.name).toBe("贵州茅台");

    const sz = formatInstrumentDisplay("000001.SZ", "cn_a");
    expect(sz.code).toBe("000001");
    expect(sz.suffix).toBe("SZ");
    expect(sz.name).toBe("平安银行");
  });
});
