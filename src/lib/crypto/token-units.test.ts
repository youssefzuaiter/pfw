import { describe, expect, it } from "vitest";
import {
  WEI_PER_ETHER,
  convertWeiToAgorot,
  etherStringToWei,
  parseHexQuantity,
  toHexQuantity,
  weiToEtherString,
} from "./token-units";

describe("parseHexQuantity / toHexQuantity", () => {
  it("parses a real eth_getBalance-shaped hex response", () => {
    // 0xde0b6b3a7640000 = 1000000000000000000 = 1 ETH in wei.
    expect(parseHexQuantity("0xde0b6b3a7640000")).toBe(1_000_000_000_000_000_000n);
  });

  it("round-trips through toHexQuantity", () => {
    expect(toHexQuantity(parseHexQuantity("0xde0b6b3a7640000"))).toBe("0xde0b6b3a7640000");
  });

  it("handles zero", () => {
    expect(parseHexQuantity("0x0")).toBe(0n);
    expect(toHexQuantity(0n)).toBe("0x0");
  });

  it("handles a value far beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
    // 10,000 ETH in wei — well past 2^53.
    const hex = "0x21e19e0c9bab2400000";
    const wei = parseHexQuantity(hex);
    expect(wei).toBe(10_000n * WEI_PER_ETHER);
    expect(wei > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("rejects a malformed hex string", () => {
    expect(() => parseHexQuantity("not-hex")).toThrow(RangeError);
    expect(() => parseHexQuantity("123")).toThrow(RangeError); // missing 0x prefix
    expect(() => parseHexQuantity("0x")).toThrow(RangeError); // no digits
  });

  it("toHexQuantity rejects a negative value", () => {
    expect(() => toHexQuantity(-1n)).toThrow(RangeError);
  });
});

describe("etherStringToWei / weiToEtherString", () => {
  it("converts 1 whole ETH exactly", () => {
    expect(etherStringToWei("1")).toBe(WEI_PER_ETHER);
    expect(weiToEtherString(WEI_PER_ETHER)).toBe("1");
  });

  it("preserves all 18 fractional digits — the whole point of this module", () => {
    const value = "0.123456789012345678"; // exactly 18 decimal places
    const wei = etherStringToWei(value);
    expect(wei).toBe(123456789012345678n);
    expect(weiToEtherString(wei)).toBe(value);
  });

  it("a single wei (the smallest possible unit) round-trips exactly", () => {
    expect(etherStringToWei("0.000000000000000001")).toBe(1n);
    expect(weiToEtherString(1n)).toBe("0.000000000000000001");
  });

  it("strips trailing zeros on the way back to a string, but not the whole part", () => {
    expect(weiToEtherString(1_500_000_000_000_000_000n)).toBe("1.5");
    expect(weiToEtherString(2n * WEI_PER_ETHER)).toBe("2");
  });

  it("handles zero", () => {
    expect(etherStringToWei("0")).toBe(0n);
    expect(weiToEtherString(0n)).toBe("0");
  });

  it("handles a large whole-number amount (beyond Number.MAX_SAFE_INTEGER once scaled to wei)", () => {
    const wei = etherStringToWei("1000000"); // 1 million ETH
    expect(wei).toBe(1_000_000n * WEI_PER_ETHER);
    expect(weiToEtherString(wei)).toBe("1000000");
  });

  it("rejects more fractional digits than the given precision allows", () => {
    expect(() => etherStringToWei("1.1234567890123456789")).toThrow(RangeError); // 19 digits, 1 too many
  });

  it("rejects a malformed or negative string", () => {
    expect(() => etherStringToWei("-1")).toThrow(RangeError);
    expect(() => etherStringToWei("abc")).toThrow(RangeError);
    expect(() => etherStringToWei("1.2.3")).toThrow(RangeError);
  });

  it("weiToEtherString rejects a negative bigint", () => {
    expect(() => weiToEtherString(-1n)).toThrow(RangeError);
  });

  it("supports a non-default decimals precision (e.g. a 6-decimal token like USDC)", () => {
    expect(etherStringToWei("1.5", 6)).toBe(1_500_000n);
    expect(weiToEtherString(1_500_000n, 6)).toBe("1.5");
  });
});

describe("convertWeiToAgorot — the 18-decimal-to-fiat conversion", () => {
  it("converts exactly 1 ETH at a realistic rate with no precision drift", () => {
    // 1 ETH at ₪12,000.50 -> 1,200,050 agorot exactly.
    const result = convertWeiToAgorot(WEI_PER_ETHER, 12_000.5);
    expect(result).toBe(1_200_050);
  });

  it("converts a sub-cent-of-ETH wei amount correctly (well below Number.MAX_SAFE_INTEGER on its own, but only after the full 18-decimal division)", () => {
    // 0.0001 ETH at ₪12,000 -> ₪1.20 -> 120 agorot.
    const wei = etherStringToWei("0.0001");
    expect(convertWeiToAgorot(wei, 12_000)).toBe(120);
  });

  it("converts a whale-sized wei balance (far beyond Number.MAX_SAFE_INTEGER) without precision loss", () => {
    // 10,000 ETH at ₪12,000.50 -> ₪120,005,000.00 -> 12,000,500,000 agorot.
    const wei = 10_000n * WEI_PER_ETHER;
    const result = convertWeiToAgorot(wei, 12_000.5);
    expect(result).toBe(12_000_500_000);
  });

  it("a single wei (1e-18 ETH) converts to 0 agorot, not a rounding error into negative or NaN", () => {
    const result = convertWeiToAgorot(1n, 12_000.5);
    expect(result).toBe(0);
  });

  it("rounds half away from zero, not truncating toward zero", () => {
    // Constructed so the exact agorot value is x.5 — verifies the
    // rounding helper isn't just relying on bigint truncation (which
    // would silently round every result DOWN, a systematic bias).
    // 0.5 ETH at a rate chosen so the agorot result lands on a half-unit boundary.
    const wei = etherStringToWei("0.5");
    // rate such that 0.5 * rate * 100 = X.5 exactly for some integer X.
    // rate = 1.001 -> 0.5 * 1.001 = 0.5005 ILS = 50.05 agorot -> rounds to 50.
    const result = convertWeiToAgorot(wei, 1.001);
    expect(result).toBe(50);
  });

  it("zero wei converts to zero agorot", () => {
    expect(convertWeiToAgorot(0n, 12_000)).toBe(0);
  });

  it("rejects a negative wei balance", () => {
    expect(() => convertWeiToAgorot(-1n, 12_000)).toThrow(RangeError);
  });

  it("rejects a non-positive or non-finite rate", () => {
    expect(() => convertWeiToAgorot(WEI_PER_ETHER, 0)).toThrow(RangeError);
    expect(() => convertWeiToAgorot(WEI_PER_ETHER, -5)).toThrow(RangeError);
    expect(() => convertWeiToAgorot(WEI_PER_ETHER, Infinity)).toThrow(RangeError);
    expect(() => convertWeiToAgorot(WEI_PER_ETHER, NaN)).toThrow(RangeError);
  });

  it("is linear in the wei amount at a fixed rate (doubling wei doubles agorot)", () => {
    const rate = 9_500.25;
    const single = convertWeiToAgorot(WEI_PER_ETHER, rate);
    const doubled = convertWeiToAgorot(2n * WEI_PER_ETHER, rate);
    expect(doubled).toBe(single * 2);
  });

  it("throws via agorot()'s own safe-integer guard for an absurdly large result, rather than silently returning a wrong number", () => {
    // An implausible amount of wei at an implausible rate, engineered to
    // push the resulting agorot figure past Number.MAX_SAFE_INTEGER.
    const wei = 10n ** 30n; // far beyond any real wallet
    expect(() => convertWeiToAgorot(wei, 1_000_000)).toThrow(RangeError);
  });
});
