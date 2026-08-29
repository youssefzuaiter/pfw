import { describe, expect, it } from "vitest";
import {
  BASE_CURRENCY,
  CURRENCY_SYMBOLS,
  SUPPORTED_CURRENCIES,
  absNativeAmount,
  addNativeAmounts,
  compareNativeAmounts,
  formatNativeAmount,
  isNegativeNativeAmount,
  isSupportedCurrency,
  isZeroNativeAmount,
  multiplyNativeAmount,
  nativeAmount,
  nativeAmountToBaseAgorot,
  negateNativeAmount,
  parseDecimalToNativeAmount,
  subtractNativeAmounts,
} from "./currency";

describe("nativeAmount()", () => {
  it("accepts safe integers", () => {
    expect(nativeAmount(19000)).toBe(19000);
  });

  it("rejects non-integers", () => {
    expect(() => nativeAmount(190.5)).toThrow(RangeError);
  });

  it("rejects unsafe integers", () => {
    expect(() => nativeAmount(Number.MAX_SAFE_INTEGER + 10)).toThrow(RangeError);
  });
});

describe("BASE_CURRENCY / SUPPORTED_CURRENCIES", () => {
  it("keeps ILS as the base currency", () => {
    expect(BASE_CURRENCY).toBe("ILS");
  });

  it("lists exactly the four supported currencies", () => {
    expect(SUPPORTED_CURRENCIES).toEqual(["ILS", "USD", "EUR", "GBP"]);
  });

  it("recognizes a supported currency and rejects an unsupported one", () => {
    expect(isSupportedCurrency("USD")).toBe(true);
    expect(isSupportedCurrency("JPY")).toBe(false);
  });

  it("has a symbol for every supported currency", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(CURRENCY_SYMBOLS[currency]).toBeTruthy();
    }
  });
});

describe("arithmetic", () => {
  it("adds and subtracts exactly", () => {
    expect(subtractNativeAmounts(nativeAmount(1000), nativeAmount(300))).toBe(700);
    expect(addNativeAmounts(nativeAmount(100), nativeAmount(200), nativeAmount(300))).toBe(600);
  });

  it("compares amounts", () => {
    expect(compareNativeAmounts(nativeAmount(100), nativeAmount(200))).toBe(-1);
    expect(compareNativeAmounts(nativeAmount(200), nativeAmount(200))).toBe(0);
    expect(compareNativeAmounts(nativeAmount(300), nativeAmount(200))).toBe(1);
  });

  it("detects zero and negative amounts", () => {
    expect(isZeroNativeAmount(nativeAmount(0))).toBe(true);
    expect(isNegativeNativeAmount(nativeAmount(-1))).toBe(true);
    expect(isNegativeNativeAmount(nativeAmount(1))).toBe(false);
  });

  it("negates and takes absolute value", () => {
    expect(negateNativeAmount(nativeAmount(500))).toBe(-500);
    expect(absNativeAmount(nativeAmount(-500))).toBe(500);
  });
});

describe("multiplyNativeAmount()", () => {
  it("rounds half away from zero", () => {
    expect(multiplyNativeAmount(nativeAmount(100), 0.125)).toBe(13);
    expect(multiplyNativeAmount(nativeAmount(100), 0.124)).toBe(12);
  });

  it("handles negative amounts and factors", () => {
    expect(multiplyNativeAmount(nativeAmount(-100), 0.5)).toBe(-50);
    expect(multiplyNativeAmount(nativeAmount(100), -0.5)).toBe(-50);
  });

  it("rejects a non-finite factor", () => {
    expect(() => multiplyNativeAmount(nativeAmount(100), Infinity)).toThrow(RangeError);
  });
});

describe("nativeAmountToBaseAgorot()", () => {
  it("passes an ILS-native amount through unchanged", () => {
    expect(nativeAmountToBaseAgorot(nativeAmount(12550), "ILS")).toBe(12550);
  });

  it("rejects a non-base currency — callers must use exchange-rate.ts instead", () => {
    expect(() => nativeAmountToBaseAgorot(nativeAmount(12550), "USD")).toThrow(RangeError);
  });
});

describe("parseDecimalToNativeAmount()", () => {
  it("parses a plain decimal", () => {
    expect(parseDecimalToNativeAmount("125.50")).toBe(12550);
  });

  it("parses thousands separators", () => {
    expect(parseDecimalToNativeAmount("1,234.56")).toBe(123456);
  });

  it("parses whole numbers with no decimal part", () => {
    expect(parseDecimalToNativeAmount("100")).toBe(10000);
  });

  it("pads a single decimal digit", () => {
    expect(parseDecimalToNativeAmount("10.5")).toBe(1050);
  });

  it("parses negative amounts", () => {
    expect(parseDecimalToNativeAmount("-42.10")).toBe(-4210);
  });

  it("trims surrounding whitespace", () => {
    expect(parseDecimalToNativeAmount("  125.50  ")).toBe(12550);
  });

  it("rejects malformed input, including a currency symbol", () => {
    expect(() => parseDecimalToNativeAmount("not money")).toThrow(RangeError);
    expect(() => parseDecimalToNativeAmount("12.345")).toThrow(RangeError);
    expect(() => parseDecimalToNativeAmount("$125.50")).toThrow(RangeError);
    expect(() => parseDecimalToNativeAmount("=SUM(A1:A2)")).toThrow(RangeError);
  });
});

describe("formatNativeAmount()", () => {
  it("formats a positive amount with the currency's symbol", () => {
    expect(formatNativeAmount(nativeAmount(19000), "USD")).toBe("$190.00");
    expect(formatNativeAmount(nativeAmount(19000), "EUR")).toBe("€190.00");
    expect(formatNativeAmount(nativeAmount(19000), "GBP")).toBe("£190.00");
  });

  it("groups thousands", () => {
    expect(formatNativeAmount(nativeAmount(123456700), "USD")).toBe("$1,234,567.00");
  });

  it("formats negative amounts with a leading minus", () => {
    expect(formatNativeAmount(nativeAmount(-4210), "USD")).toBe("-$42.10");
  });

  it("pads a single-digit cents value", () => {
    expect(formatNativeAmount(nativeAmount(500), "USD")).toBe("$5.00");
  });

  it("optionally shows a positive sign", () => {
    expect(formatNativeAmount(nativeAmount(1000), "USD", { showPositiveSign: true })).toBe("+$10.00");
    expect(formatNativeAmount(nativeAmount(0), "USD", { showPositiveSign: true })).toBe("$0.00");
  });

  it("round-trips through parseDecimalToNativeAmount for the numeric portion", () => {
    const amount = parseDecimalToNativeAmount("9,876.54");
    expect(formatNativeAmount(amount, "GBP")).toBe("£9,876.54");
  });

  it("never renders the base-currency (₪) token for a foreign currency", () => {
    expect(formatNativeAmount(nativeAmount(100), "USD")).not.toContain("₪");
  });
});
