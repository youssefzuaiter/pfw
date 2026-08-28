import { describe, expect, it } from "vitest";
import {
  agorot,
  allocateAgorot,
  compareAgorot,
  formatAgorot,
  isNegativeAgorot,
  isZeroAgorot,
  multiplyAgorot,
  parseShekelsToAgorot,
  subtractAgorot,
} from "./money";

describe("agorot()", () => {
  it("accepts safe integers", () => {
    expect(agorot(12550)).toBe(12550);
  });

  it("rejects non-integers", () => {
    expect(() => agorot(125.5)).toThrow(RangeError);
  });

  it("rejects unsafe integers", () => {
    expect(() => agorot(Number.MAX_SAFE_INTEGER + 10)).toThrow(RangeError);
  });
});

describe("arithmetic", () => {
  it("adds and subtracts exactly", () => {
    expect(subtractAgorot(agorot(1000), agorot(300))).toBe(700);
  });

  it("compares amounts", () => {
    expect(compareAgorot(agorot(100), agorot(200))).toBe(-1);
    expect(compareAgorot(agorot(200), agorot(200))).toBe(0);
    expect(compareAgorot(agorot(300), agorot(200))).toBe(1);
  });

  it("detects zero and negative amounts", () => {
    expect(isZeroAgorot(agorot(0))).toBe(true);
    expect(isNegativeAgorot(agorot(-1))).toBe(true);
    expect(isNegativeAgorot(agorot(1))).toBe(false);
  });
});

describe("multiplyAgorot()", () => {
  it("rounds half away from zero", () => {
    expect(multiplyAgorot(agorot(100), 0.125)).toBe(13); // 12.5 -> 13
    expect(multiplyAgorot(agorot(100), 0.124)).toBe(12); // 12.4 -> 12
  });

  it("handles negative amounts and factors", () => {
    expect(multiplyAgorot(agorot(-100), 0.5)).toBe(-50);
    expect(multiplyAgorot(agorot(100), -0.5)).toBe(-50);
  });
});

describe("allocateAgorot()", () => {
  it("splits an amount so the parts sum back to the total", () => {
    const parts = allocateAgorot(agorot(100), [1, 1, 1]);
    expect(parts.reduce((sum, p) => sum + p, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it("preserves the total for uneven ratios", () => {
    const total = agorot(9999);
    const parts = allocateAgorot(total, [0.5, 0.3, 0.2]);
    expect(parts.reduce((sum, p) => sum + p, 0)).toBe(9999);
  });

  it("preserves sign for negative totals", () => {
    const parts = allocateAgorot(agorot(-100), [1, 1]);
    expect(parts.reduce((sum, p) => sum + p, 0)).toBe(-100);
    expect(parts.every((p) => p <= 0)).toBe(true);
  });

  it("rejects all-zero ratios", () => {
    expect(() => allocateAgorot(agorot(100), [0, 0])).toThrow(RangeError);
  });

  it("returns an empty split for a zero total across zero shares", () => {
    expect(allocateAgorot(agorot(0), [])).toEqual([]);
  });

  it("assigns the leftover remainder unit(s) to the largest fractional remainder(s), not arbitrarily", () => {
    // ratios [1,2,3] over 100: exact shares are [16.667, 33.333, 50],
    // floors [16,33,50] sum to 99, one unit left over. Index 0 has the
    // largest fractional remainder (.667 vs .333 vs 0), so it — and only
    // it — must receive the extra unit.
    expect(allocateAgorot(agorot(100), [1, 2, 3])).toEqual([17, 33, 50]);
  });
});

describe("parseShekelsToAgorot()", () => {
  it("parses a plain decimal", () => {
    expect(parseShekelsToAgorot("125.50")).toBe(12550);
  });

  it("parses the currency symbol and thousands separators", () => {
    expect(parseShekelsToAgorot("₪1,234.56")).toBe(123456);
  });

  it("parses whole numbers with no decimal part", () => {
    expect(parseShekelsToAgorot("100")).toBe(10000);
  });

  it("pads a single decimal digit", () => {
    expect(parseShekelsToAgorot("10.5")).toBe(1050);
  });

  it("parses negative amounts", () => {
    expect(parseShekelsToAgorot("-42.10")).toBe(-4210);
  });

  it("trims surrounding whitespace, e.g. from pasted CSV cells", () => {
    expect(parseShekelsToAgorot("  125.50  ")).toBe(12550);
  });

  it("rejects malformed input", () => {
    expect(() => parseShekelsToAgorot("not money")).toThrow(RangeError);
    expect(() => parseShekelsToAgorot("12.345")).toThrow(RangeError);
    expect(() => parseShekelsToAgorot("=SUM(A1:A2)")).toThrow(RangeError);
  });
});

describe("formatAgorot()", () => {
  it("formats a positive amount with the shekel token", () => {
    expect(formatAgorot(agorot(12550))).toBe("₪125.50");
  });

  it("groups thousands", () => {
    expect(formatAgorot(agorot(123456700))).toBe("₪1,234,567.00");
  });

  it("formats negative amounts with a leading minus", () => {
    expect(formatAgorot(agorot(-4210))).toBe("-₪42.10");
  });

  it("pads a single-digit cents value", () => {
    expect(formatAgorot(agorot(500))).toBe("₪5.00");
  });

  it("optionally shows a positive sign", () => {
    expect(formatAgorot(agorot(1000), { showPositiveSign: true })).toBe("+₪10.00");
    expect(formatAgorot(agorot(0), { showPositiveSign: true })).toBe("₪0.00");
  });

  it("round-trips through parseShekelsToAgorot", () => {
    const original = "₪9,876.54";
    expect(formatAgorot(parseShekelsToAgorot(original))).toBe(original);
  });
});
