import { describe, expect, it } from "vitest";
import { getMockPriceAgorot, getMockPriceHistory, isKnownMockSymbol, listMockSymbols } from "./mock-market-data";

describe("getMockPriceAgorot()", () => {
  it("is deterministic for the same symbol and day", () => {
    const date = new Date("2026-08-15T10:00:00Z");
    expect(getMockPriceAgorot("AAPL", date)).toBe(getMockPriceAgorot("AAPL", date));
  });

  it("is the same regardless of time-of-day within the same calendar day", () => {
    const morning = new Date("2026-08-15T01:00:00Z");
    const evening = new Date("2026-08-15T23:00:00Z");
    expect(getMockPriceAgorot("AAPL", morning)).toBe(getMockPriceAgorot("AAPL", evening));
  });

  it("differs across two different symbols", () => {
    const date = new Date("2026-08-15T10:00:00Z");
    expect(getMockPriceAgorot("AAPL", date)).not.toBe(getMockPriceAgorot("MSFT", date));
  });

  it("stays within a plausible +/-3% band of the mocked USD base price", () => {
    // AAPL base 190 USD * 3.7 rate = 703 ILS = 70300 agorot, +/-3%.
    const price = getMockPriceAgorot("AAPL", new Date("2026-08-15T00:00:00Z"));
    expect(price).toBeGreaterThan(70300 * 0.96);
    expect(price).toBeLessThan(70300 * 1.04);
  });

  it("rejects an unknown symbol", () => {
    expect(() => getMockPriceAgorot("UNKNOWN")).toThrow(RangeError);
  });
});

describe("getMockPriceHistory()", () => {
  it("returns exactly `days` points, ending on endDate", () => {
    const endDate = new Date("2026-08-15T00:00:00Z");
    const history = getMockPriceHistory("AAPL", 10, endDate);
    expect(history).toHaveLength(10);
    expect(history.at(-1)?.date.toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("is in chronological order", () => {
    const history = getMockPriceHistory("AAPL", 5, new Date("2026-08-15T00:00:00Z"));
    for (let i = 1; i < history.length; i++) {
      expect(history[i].date.getTime()).toBeGreaterThan(history[i - 1].date.getTime());
    }
  });

  it("each point matches getMockPriceAgorot for that day", () => {
    const endDate = new Date("2026-08-15T00:00:00Z");
    const history = getMockPriceHistory("AAPL", 3, endDate);
    for (const point of history) {
      expect(point.price).toBe(getMockPriceAgorot("AAPL", point.date));
    }
  });

  it("rejects a non-positive days value", () => {
    expect(() => getMockPriceHistory("AAPL", 0)).toThrow(RangeError);
  });
});

describe("isKnownMockSymbol() / listMockSymbols()", () => {
  it("recognizes a known symbol", () => {
    expect(isKnownMockSymbol("AAPL")).toBe(true);
    expect(isKnownMockSymbol("NOPE")).toBe(false);
  });

  it("lists a non-empty, deduplicated set of symbols", () => {
    const symbols = listMockSymbols();
    expect(symbols.length).toBeGreaterThan(0);
    expect(new Set(symbols).size).toBe(symbols.length);
  });
});
