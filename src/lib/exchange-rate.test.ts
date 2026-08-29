import { describe, expect, it } from "vitest";
import { agorot } from "./money";
import { nativeAmount } from "./currency";
import {
  FALLBACK_RATES,
  IDENTITY_RATE,
  assertValidRate,
  convertAgorotToNativeAmount,
  convertNativeAmountToAgorot,
  formatExchangeRate,
} from "./exchange-rate";

describe("FALLBACK_RATES / IDENTITY_RATE", () => {
  it("has a positive fallback rate for every non-base currency", () => {
    for (const rate of Object.values(FALLBACK_RATES)) {
      expect(rate).toBeGreaterThan(0);
    }
  });

  it("keeps the identity rate at exactly 1", () => {
    expect(IDENTITY_RATE).toBe(1);
  });
});

describe("assertValidRate()", () => {
  it("accepts a positive finite rate", () => {
    expect(() => assertValidRate(3.7, "USD")).not.toThrow();
  });

  it("rejects zero, negative, infinite, and NaN rates", () => {
    expect(() => assertValidRate(0, "USD")).toThrow(RangeError);
    expect(() => assertValidRate(-3.7, "USD")).toThrow(RangeError);
    expect(() => assertValidRate(Infinity, "USD")).toThrow(RangeError);
    expect(() => assertValidRate(Number.NaN, "USD")).toThrow(RangeError);
  });
});

describe("convertNativeAmountToAgorot()", () => {
  it("converts USD cents to agorot using the given rate", () => {
    // $100.00 (10000 cents) at 3.7 ILS/USD = ₪370.00 (37000 agorot).
    expect(convertNativeAmountToAgorot(nativeAmount(10000), "USD", 3.7)).toBe(37000);
  });

  it("rounds half away from zero", () => {
    // 1 cent at rate 0.5 -> 0.5 agorot -> rounds to 1 (away from zero).
    expect(convertNativeAmountToAgorot(nativeAmount(1), "USD", 0.5)).toBe(1);
    // 1 cent at rate 0.49 -> 0.49 -> rounds to 0.
    expect(convertNativeAmountToAgorot(nativeAmount(1), "USD", 0.49)).toBe(0);
  });

  it("preserves sign for a negative (expense) amount", () => {
    expect(convertNativeAmountToAgorot(nativeAmount(-10000), "USD", 3.7)).toBe(-37000);
  });

  it("passes an ILS-native amount through unchanged and ignores the rate entirely", () => {
    expect(convertNativeAmountToAgorot(nativeAmount(12550), "ILS", 999)).toBe(12550);
    // Even a rate of 0 (normally invalid) is fine for ILS since it's never used.
    expect(convertNativeAmountToAgorot(nativeAmount(12550), "ILS", 0)).toBe(12550);
  });

  it("rejects a non-positive rate for a foreign currency", () => {
    expect(() => convertNativeAmountToAgorot(nativeAmount(100), "USD", 0)).toThrow(RangeError);
    expect(() => convertNativeAmountToAgorot(nativeAmount(100), "USD", -1)).toThrow(RangeError);
  });

  it("handles a zero amount", () => {
    expect(convertNativeAmountToAgorot(nativeAmount(0), "EUR", 4.0)).toBe(0);
  });
});

describe("convertAgorotToNativeAmount()", () => {
  it("is the inverse of convertNativeAmountToAgorot for exact rates", () => {
    const original = nativeAmount(10000);
    const converted = convertNativeAmountToAgorot(original, "USD", 4);
    expect(convertAgorotToNativeAmount(agorot(converted), "USD", 4)).toBe(10000);
  });

  it("rounds half away from zero", () => {
    expect(convertAgorotToNativeAmount(agorot(1), "USD", 2)).toBe(1); // 0.5 -> 1
  });

  it("passes an ILS amount through unchanged", () => {
    expect(convertAgorotToNativeAmount(agorot(12550), "ILS", 999)).toBe(12550);
  });

  it("rejects a non-positive rate for a foreign currency", () => {
    expect(() => convertAgorotToNativeAmount(agorot(100), "GBP", 0)).toThrow(RangeError);
  });
});

describe("formatExchangeRate()", () => {
  it("formats to 4 decimal places by default", () => {
    expect(formatExchangeRate(3.7, "USD")).toBe("3.7000");
  });

  it("supports a custom precision", () => {
    expect(formatExchangeRate(3.71234, "USD", 2)).toBe("3.71");
  });

  it("rejects an invalid rate", () => {
    expect(() => formatExchangeRate(-1, "USD")).toThrow(RangeError);
  });
});
