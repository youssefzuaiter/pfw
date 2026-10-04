import { describe, expect, it } from "vitest";
import {
  decimalToBasisPoints,
  decimalToCents,
  formatDecimalTrimmed,
  multiplyDecimalsToCents,
  parseDecimalString,
  roundDecimalString,
  sumProductsToCentsTruncated,
} from "./decimal-string";

describe("parseDecimalString", () => {
  it("reads an integer, a fraction and a negative as exact units over a power of ten", () => {
    expect(parseDecimalString("12")).toEqual({ units: 12n, scale: 0 });
    expect(parseDecimalString("12.50")).toEqual({ units: 1250n, scale: 2 });
    expect(parseDecimalString("-0.005")).toEqual({ units: -5n, scale: 3 });
  });

  it("keeps digits a float would lose", () => {
    // 0.1 + 0.2 is the classic; here the point is simply that nothing is rounded on the way in.
    expect(parseDecimalString("0.30000000000000004")).toEqual({ units: 30000000000000004n, scale: 17 });
    expect(parseDecimalString("9007199254740993").units).toBe(9007199254740993n);
  });

  it.each(["", " ", "abc", "1e5", "1,000", "1.", ".5", "--1", "1.2.3", "+1", "NaN", "Infinity"])(
    "refuses %j",
    (input) => {
      expect(() => parseDecimalString(input)).toThrow(RangeError);
    },
  );

  it("refuses an absurdly long fraction rather than allocating for it", () => {
    expect(() => parseDecimalString(`0.${"1".repeat(40)}`)).toThrow(RangeError);
  });
});

describe("multiplyDecimalsToCents", () => {
  it("multiplies exactly: 12.5 shares at 190.12", () => {
    expect(multiplyDecimalsToCents("12.5", "190.12")).toBe(237_650);
  });

  it("rounds half up at the cent", () => {
    expect(multiplyDecimalsToCents("1", "0.005")).toBe(1); // half a cent
    expect(multiplyDecimalsToCents("1", "0.004")).toBe(0);
    expect(multiplyDecimalsToCents("100", "0.005")).toBe(50);
  });

  it("rounds half away from zero for a negative result", () => {
    expect(multiplyDecimalsToCents("-1", "0.005")).toBe(-1);
    expect(multiplyDecimalsToCents("-1", "0.004")).toBe(0);
  });

  it("handles Alpaca's nine-decimal share quantities", () => {
    // 0.123456789 sh x 100.5 = 12.4074073... dollars = 1240.74 cents
    expect(multiplyDecimalsToCents("0.123456789", "100.5")).toBe(1241);
  });

  it("is zero for a fill of nothing", () => {
    expect(multiplyDecimalsToCents("0", "190.12")).toBe(0);
    expect(multiplyDecimalsToCents("0.000000001", "1")).toBe(0);
  });

  it("refuses a result that does not fit a safe integer", () => {
    expect(() => multiplyDecimalsToCents("99999999999999", "99999999999999")).toThrow(RangeError);
  });
});

describe("sumProductsToCentsTruncated", () => {
  it("sums the exact products and truncates once, the way the router records a plan's traded dollars", () => {
    // 18.5 x 102.69 = 1899.765, plus half a cent, is exactly 1899.770.
    expect(
      sumProductsToCentsTruncated([
        ["18.5", "102.69"],
        ["1", "0.005"],
      ]),
    ).toBe(189_977); // 1899.765 + 0.005 = 1899.77 exactly
  });

  it("truncates where per-order rounding would round up: two half-cents are one cent, not two", () => {
    expect(
      sumProductsToCentsTruncated([
        ["1", "0.005"],
        ["1", "0.004"],
      ]),
    ).toBe(0); // 0.009 dollars = 0.9 cents
    expect(
      sumProductsToCentsTruncated([
        ["1", "0.005"],
        ["1", "0.005"],
      ]),
    ).toBe(1); // 0.010 dollars = 1 cent (rounding each half-cent up first would say 2)
  });

  it("is zero for no fills", () => {
    expect(sumProductsToCentsTruncated([])).toBe(0);
  });

  it("copes with operands of very different scales", () => {
    expect(
      sumProductsToCentsTruncated([
        ["0.123456789", "100.5"], // 12.4074073945 dollars
        ["2", "3"], // 6 dollars
      ]),
    ).toBe(1840); // 18.4074... dollars -> 1840 cents (truncated)
  });
});

describe("decimalToCents", () => {
  it("converts dollars to cents, rounding half up", () => {
    expect(decimalToCents("1899.81")).toBe(189_981);
    expect(decimalToCents("0.005")).toBe(1);
    expect(decimalToCents("0.004")).toBe(0);
    expect(decimalToCents("10000")).toBe(1_000_000);
    expect(decimalToCents("-2.5")).toBe(-250);
  });
});

describe("decimalToBasisPoints", () => {
  it("reads a weight as basis points", () => {
    expect(decimalToBasisPoints("0.19")).toBe(1900);
    expect(decimalToBasisPoints("0.05")).toBe(500);
    expect(decimalToBasisPoints("1")).toBe(10_000);
    expect(decimalToBasisPoints("0")).toBe(0);
  });

  it("rounds a finer weight to the nearest basis point, half up", () => {
    expect(decimalToBasisPoints("0.18995")).toBe(1900); // 1899.5 bp
    expect(decimalToBasisPoints("0.18994")).toBe(1899);
  });
});

describe("formatDecimalTrimmed", () => {
  it("drops trailing zeros and a bare point", () => {
    expect(formatDecimalTrimmed("12.500000000")).toBe("12.5");
    expect(formatDecimalTrimmed("12.000")).toBe("12");
    expect(formatDecimalTrimmed("0.123456789")).toBe("0.123456789");
  });

  it("caps the fraction when asked, truncating rather than rounding up into a different number", () => {
    expect(formatDecimalTrimmed("0.123456789", 4)).toBe("0.1234");
    expect(formatDecimalTrimmed("5.1000001", 4)).toBe("5.1");
  });

  it("returns the input unchanged when it is not a decimal at all (display text, never an exception)", () => {
    expect(formatDecimalTrimmed("n/a")).toBe("n/a");
    expect(formatDecimalTrimmed("")).toBe("");
  });
});

describe("roundDecimalString", () => {
  it("rounds half away from zero to the given number of places", () => {
    expect(roundDecimalString("102.69125", 4)).toBe("102.6913");
    expect(roundDecimalString("102.69124", 4)).toBe("102.6912");
    expect(roundDecimalString("-102.69125", 4)).toBe("-102.6913");
    expect(roundDecimalString("0.995", 2)).toBe("1.00");
    expect(roundDecimalString("9.999", 2)).toBe("10.00");
  });

  it("pads a short fraction rather than leaving it short", () => {
    expect(roundDecimalString("91", 2)).toBe("91.00");
    expect(roundDecimalString("91.5", 4)).toBe("91.5000");
    expect(roundDecimalString("5", 0)).toBe("5");
  });

  it("keeps the sign of a value that rounds to zero out of it", () => {
    expect(roundDecimalString("-0.004", 2)).toBe("0.00");
  });

  it("returns what it cannot read unchanged, so a label never throws", () => {
    expect(roundDecimalString("n/a", 2)).toBe("n/a");
  });
});
