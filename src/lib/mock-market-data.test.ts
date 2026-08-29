import { describe, expect, it } from "vitest";
import {
  getMockDividendSchedule,
  getMockInstrument,
  getMockPriceAgorot,
  getMockPriceHistory,
  getMockPriceUsdCents,
  isKnownMockSymbol,
  listMockInstruments,
  listMockSymbols,
} from "./mock-market-data";

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

  it("uses the supplied USD->ILS rate instead of the fallback", () => {
    const date = new Date("2026-08-15T00:00:00Z");
    const cents = getMockPriceUsdCents("AAPL", date);
    const atDoubleRate = getMockPriceAgorot("AAPL", date, 7.4);
    expect(atDoubleRate).toBe(Math.round(cents * 7.4));
    expect(atDoubleRate).not.toBe(getMockPriceAgorot("AAPL", date));
  });
});

describe("getMockPriceUsdCents()", () => {
  it("is independent of any exchange rate — native USD cents only", () => {
    const date = new Date("2026-08-15T00:00:00Z");
    // AAPL base 190 USD = 19000 cents, +/-3%.
    const cents = getMockPriceUsdCents("AAPL", date);
    expect(cents).toBeGreaterThan(19000 * 0.96);
    expect(cents).toBeLessThan(19000 * 1.04);
  });

  it("is what getMockPriceAgorot converts at the fallback rate", () => {
    const date = new Date("2026-08-15T00:00:00Z");
    const cents = getMockPriceUsdCents("AAPL", date);
    expect(getMockPriceAgorot("AAPL", date, 3.7)).toBe(Math.round(cents * 3.7));
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

describe("listMockInstruments() / getMockInstrument()", () => {
  it("covers all three asset classes", () => {
    const classes = new Set(listMockInstruments().map((i) => i.assetClass));
    expect(classes).toEqual(new Set(["STOCK", "ETF", "CRYPTO"]));
  });

  it("gives every instrument a positive base price and a name", () => {
    for (const instrument of listMockInstruments()) {
      expect(instrument.usdBasePrice).toBeGreaterThan(0);
      expect(instrument.name.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate symbols", () => {
    const symbols = listMockInstruments().map((i) => i.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it("never gives a crypto instrument a dividend", () => {
    for (const instrument of listMockInstruments().filter((i) => i.assetClass === "CRYPTO")) {
      expect(instrument.dividend).toBeNull();
    }
  });

  it("rejects an unknown symbol", () => {
    expect(() => getMockInstrument("NOPE")).toThrow(RangeError);
  });
});

describe("getMockDividendSchedule()", () => {
  const asOf = new Date("2026-08-28T00:00:00Z");

  it("returns an empty schedule for an instrument that pays nothing", () => {
    expect(getMockDividendSchedule("BTC", asOf)).toEqual([]);
    expect(getMockDividendSchedule("GOOGL", asOf)).toEqual([]);
  });

  it("returns roughly one year back and one year forward of quarterly payments", () => {
    const events = getMockDividendSchedule("AAPL", asOf);
    // ~4 per year over a 2-year window, allowing for boundary alignment.
    expect(events.length).toBeGreaterThanOrEqual(7);
    expect(events.length).toBeLessThanOrEqual(9);
  });

  it("is deterministic for the same symbol and date", () => {
    expect(getMockDividendSchedule("AAPL", asOf)).toEqual(getMockDividendSchedule("AAPL", asOf));
  });

  it("always pays after the ex-date", () => {
    for (const event of getMockDividendSchedule("MSFT", asOf)) {
      expect(event.payDate.getTime()).toBeGreaterThan(event.exDate.getTime());
    }
  });

  it("is in chronological order", () => {
    const events = getMockDividendSchedule("SPY", asOf);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].exDate.getTime()).toBeGreaterThan(events[i - 1].exDate.getTime());
    }
  });

  it("keeps every event inside the requested window", () => {
    const events = getMockDividendSchedule("AAPL", asOf, 90, 90);
    const lower = asOf.getTime() - 90 * 24 * 60 * 60 * 1000;
    const upper = asOf.getTime() + 90 * 24 * 60 * 60 * 1000;
    for (const event of events) {
      expect(event.exDate.getTime()).toBeGreaterThanOrEqual(lower);
      expect(event.exDate.getTime()).toBeLessThanOrEqual(upper);
    }
  });

  it("uses an integer per-share amount in native minor units", () => {
    for (const event of getMockDividendSchedule("MSFT", asOf)) {
      expect(Number.isInteger(event.amountPerShareNative)).toBe(true);
      expect(event.amountPerShareNative).toBeGreaterThan(0);
    }
  });

  it("staggers ex-dates across different symbols rather than paying all on one day", () => {
    const aapl = getMockDividendSchedule("AAPL", asOf).map((e) => e.exDate.getTime());
    const msft = getMockDividendSchedule("MSFT", asOf).map((e) => e.exDate.getTime());
    expect(aapl.some((t) => msft.includes(t))).toBe(false);
  });

  it("rejects an unknown symbol", () => {
    expect(() => getMockDividendSchedule("NOPE", asOf)).toThrow(RangeError);
  });
});
