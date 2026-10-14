import { describe, expect, it } from "vitest";
import { convertAgorotExact, rateMicrosFromDecimal, rateMicrosFromNumber, rateOnDay, sortRateHistory, utcDayKey, type RatePoint } from "./fx-history";

/** The date-aware rate lookup and the one exact conversion (AGENTS.md §3vvv). */
describe("utcDayKey", () => {
  it("cuts days at UTC midnight: 23:59:59 is still that day, 00:00:01 is the next", () => {
    expect(utcDayKey(new Date("2026-08-31T23:59:59.999Z"))).toBe("2026-08-31");
    expect(utcDayKey(new Date("2026-09-01T00:00:01Z"))).toBe("2026-09-01");
    expect(utcDayKey(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09-01");
  });

  it("reads an instant with an offset as its UTC day, and keeps a plain day as it is", () => {
    // 01:00 in Istanbul on 1 March is 22:00 UTC on 28 February.
    expect(utcDayKey("2026-03-01T01:00:00+03:00")).toBe("2026-02-28");
    expect(utcDayKey("2026-03-01")).toBe("2026-03-01");
  });

  it("handles the leap day", () => {
    expect(utcDayKey(new Date("2024-02-29T23:59:59.999Z"))).toBe("2024-02-29");
    expect(utcDayKey(new Date(Date.parse("2024-02-29T23:59:59.999Z") + 1))).toBe("2024-03-01");
  });

  it("refuses something that is not a date", () => {
    expect(() => utcDayKey("not a date")).toThrow(RangeError);
  });
});

describe("rate micros", () => {
  it("reads the stored Decimal(12,6) text exactly, never through a float", () => {
    expect(rateMicrosFromDecimal("3.037667")).toBe(3_037_667);
    expect(rateMicrosFromDecimal("0.062267")).toBe(62_267);
    expect(rateMicrosFromDecimal("4")).toBe(4_000_000);
    expect(rateMicrosFromDecimal("3.1")).toBe(3_100_000);
    expect(rateMicrosFromDecimal("3.7000004")).toBe(3_700_000);
  });

  it("refuses zero, negatives, exponents and garbage", () => {
    for (const text of ["0", "0.000000", "-1.5", "1e-3", "abc", ""]) expect(() => rateMicrosFromDecimal(text)).toThrow(RangeError);
  });

  it("rounds a numeric fallback rate to the stored precision", () => {
    expect(rateMicrosFromNumber(3.7)).toBe(3_700_000);
    expect(rateMicrosFromNumber(0.09)).toBe(90_000);
    expect(() => rateMicrosFromNumber(0)).toThrow(RangeError);
    expect(() => rateMicrosFromNumber(Number.NaN)).toThrow(RangeError);
  });
});

describe("convertAgorotExact", () => {
  it("rounds half away from zero, in both directions", () => {
    const tenShekels = 10_000_000; // 10 ILS per unit
    expect(convertAgorotExact(15, tenShekels)).toBe(2); // 1.5
    expect(convertAgorotExact(-15, tenShekels)).toBe(-2);
    expect(convertAgorotExact(25, tenShekels)).toBe(3); // 2.5: away from zero, not to even
    expect(convertAgorotExact(14, tenShekels)).toBe(1);
    expect(convertAgorotExact(-14, tenShekels)).toBe(-1);
    expect(convertAgorotExact(0, tenShekels)).toBe(0);
  });

  it("gets an exact half right where floating-point division does not", () => {
    // 33 agorot at 4.4 is exactly 7.5 units; 33 / 4.4 in floating point is
    // 7.499999999999999, which the old conversion rounded down to 7.
    expect(33 / 4.4).toBeLessThan(7.5);
    expect(convertAgorotExact(33, 4_400_000)).toBe(8);
    expect(convertAgorotExact(-33, 4_400_000)).toBe(-8);
  });

  it("converts real amounts at a real rate", () => {
    // -₪1,250.00 at ₪3.037667 per $1 = -$411.50 (41,150.00098… cents, rounded).
    expect(convertAgorotExact(-125_000, 3_037_667)).toBe(-41_150);
    // ₪100.00 at ₪0.062267 per ₺1 is ₺1,605.99 (160,598.71… kuruş, rounded).
    expect(convertAgorotExact(10_000, 62_267)).toBe(160_599);
  });

  it("is exact for amounts far beyond 2^53 agorot as a bigint, and refuses an unsafe result", () => {
    expect(convertAgorotExact(9_007_199_254_740_991n, 1_000_000)).toBe(9_007_199_254_740_991);
    expect(() => convertAgorotExact(10n ** 20n, 1_000_000)).toThrow(RangeError);
    expect(() => convertAgorotExact(1.5, 1_000_000)).toThrow(RangeError);
    expect(() => convertAgorotExact(100, 0)).toThrow(RangeError);
  });
});

describe("rateOnDay", () => {
  // Thursday 27 and Friday 28 August, Monday 31 August 2026; the weekend in between has no rate.
  const history: RatePoint[] = [
    { day: "2026-08-27", micros: 3_020_000 },
    { day: "2026-08-28", micros: 3_030_000 },
    { day: "2026-08-31", micros: 3_040_000 },
    { day: "2026-12-24", micros: 3_100_000 },
    { day: "2026-12-28", micros: 3_110_000 },
  ];
  const fallback = 3_700_000;

  it("uses the day's own rate when one was published", () => {
    expect(rateOnDay(history, "2026-08-28", fallback)).toEqual({ micros: 3_030_000, rateDay: "2026-08-28", approximate: false });
    expect(rateOnDay(history, "2026-08-31", fallback).micros).toBe(3_040_000);
  });

  it("gives a Saturday and a Sunday the Friday rate", () => {
    expect(rateOnDay(history, "2026-08-29", fallback)).toEqual({ micros: 3_030_000, rateDay: "2026-08-28", approximate: false });
    expect(rateOnDay(history, "2026-08-30", fallback).rateDay).toBe("2026-08-28");
  });

  it("gives a holiday run the last business day's rate", () => {
    for (const day of ["2026-12-25", "2026-12-26", "2026-12-27"]) expect(rateOnDay(history, day, fallback).rateDay).toBe("2026-12-24");
  });

  it("uses the newest rate for any day after the last one stored", () => {
    expect(rateOnDay(history, "2027-03-01", fallback)).toEqual({ micros: 3_110_000, rateDay: "2026-12-28", approximate: false });
  });

  it("uses the earliest rate, flagged approximate, before the history starts", () => {
    expect(rateOnDay(history, "2025-01-01", fallback)).toEqual({ micros: 3_020_000, rateDay: "2026-08-27", approximate: true });
  });

  it("uses the fallback with no history at all", () => {
    expect(rateOnDay([], "2026-08-28", fallback)).toEqual({ micros: fallback, rateDay: null, approximate: true });
  });

  it("handles a leap-day rate and the days around it", () => {
    const leap: RatePoint[] = [
      { day: "2024-02-28", micros: 3_600_000 },
      { day: "2024-02-29", micros: 3_610_000 },
      { day: "2024-03-01", micros: 3_620_000 },
    ];
    expect(rateOnDay(leap, utcDayKey(new Date("2024-02-29T23:59:59Z")), fallback).micros).toBe(3_610_000);
    expect(rateOnDay(leap, utcDayKey(new Date("2024-03-01T00:00:01Z")), fallback).micros).toBe(3_620_000);
    expect(rateOnDay(leap, "2024-03-02", fallback).rateDay).toBe("2024-03-01"); // Saturday
  });

  it("finds the same rate as a plain scan for every day of a long history", () => {
    const long: RatePoint[] = [];
    for (let day = Date.UTC(2023, 0, 2); day < Date.UTC(2026, 11, 31); day += 86_400_000) {
      const weekday = new Date(day).getUTCDay();
      if (weekday !== 0 && weekday !== 6) long.push({ day: utcDayKey(new Date(day)), micros: 3_000_000 + long.length });
    }
    for (let day = Date.UTC(2022, 11, 25); day < Date.UTC(2027, 0, 10); day += 86_400_000 * 3) {
      const key = utcDayKey(new Date(day));
      const scan = [...long].reverse().find((point) => point.day <= key) ?? long[0];
      expect(rateOnDay(long, key, fallback).micros).toBe(scan.micros);
    }
  });
});

describe("sortRateHistory", () => {
  it("sorts oldest first, keeps the last value given for a day, and drops invalid points", () => {
    expect(
      sortRateHistory([
        { day: "2026-08-31", micros: 3 },
        { day: "2026-08-28", micros: 1 },
        { day: "2026-08-28", micros: 2 },
        { day: "bad", micros: 5 },
        { day: "2026-09-01", micros: 0 },
      ]),
    ).toEqual([
      { day: "2026-08-28", micros: 2 },
      { day: "2026-08-31", micros: 3 },
    ]);
  });
});
