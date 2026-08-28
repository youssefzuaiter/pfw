import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import {
  accrueInterest,
  annualBpsToMonthlyRate,
  bps,
  bpsToDecimalRate,
  decimalRateToBps,
  formatBpsAsPercent,
} from "./apr";

describe("bps()", () => {
  it("accepts integers", () => {
    expect(bps(725)).toBe(725);
  });

  it("rejects non-integers", () => {
    expect(() => bps(7.25)).toThrow(RangeError);
  });
});

describe("rate conversions", () => {
  it("converts basis points to a decimal rate", () => {
    expect(bpsToDecimalRate(bps(725))).toBeCloseTo(0.0725, 10);
  });

  it("converts a decimal rate to basis points, rounding to the nearest bp", () => {
    expect(decimalRateToBps(0.0725)).toBe(725);
    expect(decimalRateToBps(0.072501)).toBe(725);
  });

  it("round-trips", () => {
    expect(decimalRateToBps(bpsToDecimalRate(bps(1999)))).toBe(1999);
  });
});

describe("formatBpsAsPercent()", () => {
  it("formats basis points as a percent string", () => {
    expect(formatBpsAsPercent(bps(725))).toBe("7.25%");
    expect(formatBpsAsPercent(bps(100))).toBe("1.00%");
    expect(formatBpsAsPercent(bps(50), 1)).toBe("0.5%");
  });
});

describe("annualBpsToMonthlyRate()", () => {
  it("divides the nominal annual rate by 12", () => {
    expect(annualBpsToMonthlyRate(bps(1200))).toBeCloseTo(0.01, 10);
  });
});

describe("accrueInterest()", () => {
  it("computes monthly interest on a principal", () => {
    // 10,000.00 at 12.00% APR, monthly: 1% of 1,000,000 agorot = 10,000 agorot
    expect(accrueInterest(agorot(1_000_000), bps(1200))).toBe(10_000);
  });

  it("rounds to the nearest agorot", () => {
    // 100.00 at 7.25% APR, monthly: 100 * 0.0725 / 12 = 0.604166... -> 60 agorot / 10000 -> round
    expect(accrueInterest(agorot(10_000), bps(725))).toBe(60);
  });

  it("supports non-monthly periods", () => {
    // Annual period: full year's interest in one shot.
    expect(accrueInterest(agorot(1_000_000), bps(1200), 1)).toBe(120_000);
  });
});
