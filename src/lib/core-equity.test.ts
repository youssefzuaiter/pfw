import { describe, expect, it } from "vitest";
import { summarizeEquity, type EquityPoint, compareWithBenchmark, toDailyBenchmarkQuotes, MAX_BENCHMARK_QUOTE_AGE_DAYS } from "./core-equity";

const point = (day: string, usdCents: number): EquityPoint => ({
  day,
  usdCents,
});

describe("summarizeEquity", () => {
  it("has nothing to say about fewer than two points", () => {
    expect(summarizeEquity([])).toBeNull();
    expect(summarizeEquity([point("2026-10-05", 1_000_000)])).toBeNull();
  });

  it("reports the change from the first point to the last, in cents and basis points", () => {
    const summary = summarizeEquity([
      point("2026-10-05", 1_000_000),
      point("2026-10-06", 1_010_000),
      point("2026-10-12", 1_025_000),
    ]);
    expect(summary).toEqual({
      firstDay: "2026-10-05",
      lastDay: "2026-10-12",
      firstUsdCents: 1_000_000,
      lastUsdCents: 1_025_000,
      changeUsdCents: 25_000,
      changeBps: 250, // +2.50%
      spanDays: 7,
    });
  });

  it("is negative when the account is down, and rounds half away from zero symmetrically", () => {
    const down = summarizeEquity([point("2026-10-05", 1_000_000), point("2026-10-06", 985_000)]);
    expect(down?.changeUsdCents).toBe(-15_000);
    expect(down?.changeBps).toBe(-150);

    // 1 cent on 20,000 cents is exactly half a basis point; half rounds away from zero, both ways.
    expect(summarizeEquity([point("2026-10-05", 20_000), point("2026-10-06", 20_001)])?.changeBps).toBe(1);
    expect(summarizeEquity([point("2026-10-05", 20_000), point("2026-10-06", 19_999)])?.changeBps).toBe(-1);
  });

  it("is flat, not undefined, when nothing moved", () => {
    const summary = summarizeEquity([point("2026-10-05", 1_000_000), point("2026-10-06", 1_000_000)]);
    expect(summary?.changeUsdCents).toBe(0);
    expect(summary?.changeBps).toBe(0);
  });

  it("gives no percentage when the starting value is not positive (but still the dollar change)", () => {
    const summary = summarizeEquity([point("2026-10-05", 0), point("2026-10-06", 500_000)]);
    expect(summary?.changeUsdCents).toBe(500_000);
    expect(summary?.changeBps).toBeNull();
  });

  it("counts calendar days across a gap, month and year boundaries included", () => {
    expect(summarizeEquity([point("2026-10-30", 1), point("2026-11-02", 1)])?.spanDays).toBe(3);
    expect(summarizeEquity([point("2026-12-30", 1), point("2027-01-02", 1)])?.spanDays).toBe(3);
    // A leap day is a day.
    expect(summarizeEquity([point("2028-02-28", 1), point("2028-03-01", 1)])?.spanDays).toBe(2);
  });

  it("uses the first and last points as given, without re-sorting", () => {
    // The DAL returns oldest first; an out-of-order series is a bug that should show, not be quietly fixed.
    const summary = summarizeEquity([point("2026-10-09", 1_100_000), point("2026-10-05", 1_000_000)]);
    expect(summary?.firstDay).toBe("2026-10-09");
    expect(summary?.changeUsdCents).toBe(-100_000);
  });
});

describe("compareWithBenchmark", () => {
  const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
  const points = (...cents: number[]): EquityPoint[] => cents.map((usdCents, i) => ({ day: day(5 + i), usdCents }));

  it("starts both lines at the same amount on the first day with a price, and scales by the price change", () => {
    const result = compareWithBenchmark(points(1_000_000, 1_010_000, 990_000), [
      { day: day(5), priceUsd: 100 },
      { day: day(6), priceUsd: 102 },
      { day: day(7), priceUsd: 99.5 },
    ]);
    expect(result.points.map((p) => p.benchmarkUsdCents)).toEqual([1_000_000, 1_020_000, 995_000]);
    expect(result.summary).toEqual({ sinceDay: day(5), lastDay: day(7), benchmarkChangeBps: -50, accountChangeBps: -100 });
  });

  it("leaves days before the first price empty, and compares from that day, not from the account's first day", () => {
    const result = compareWithBenchmark(points(1_000_000, 1_100_000, 1_210_000), [
      { day: day(6), priceUsd: 50 },
      { day: day(7), priceUsd: 55 },
    ]);
    expect(result.points.map((p) => p.benchmarkUsdCents)).toEqual([null, 1_100_000, 1_210_000]);
    expect(result.summary).toEqual({ sinceDay: day(6), lastDay: day(7), benchmarkChangeBps: 1000, accountChangeBps: 1000 });
  });

  it("carries a price forward over a weekend, but not past the age limit", () => {
    const quotes = [{ day: day(5), priceUsd: 100 }];
    const within = compareWithBenchmark(
      [
        { day: day(5), usdCents: 1_000_000 },
        { day: day(5 + MAX_BENCHMARK_QUOTE_AGE_DAYS), usdCents: 1_000_000 },
      ],
      quotes,
    );
    expect(within.points.map((p) => p.benchmarkUsdCents)).toEqual([1_000_000, 1_000_000]);

    const beyond = compareWithBenchmark(
      [
        { day: day(5), usdCents: 1_000_000 },
        { day: day(6 + MAX_BENCHMARK_QUOTE_AGE_DAYS), usdCents: 1_000_000 },
      ],
      quotes,
    );
    expect(beyond.points.map((p) => p.benchmarkUsdCents)).toEqual([1_000_000, null]);
    expect(beyond.summary).toBeNull();
  });

  it("has no summary with fewer than two compared days, and ignores a non-positive price", () => {
    expect(compareWithBenchmark(points(1_000_000, 1_010_000), []).summary).toBeNull();
    expect(compareWithBenchmark(points(1_000_000, 1_010_000), [{ day: day(5), priceUsd: 0 }]).summary).toBeNull();
  });
});

describe("toDailyBenchmarkQuotes", () => {
  it("keys each price by the UTC day of its trade and keeps the latest observation of a day", () => {
    expect(
      toDailyBenchmarkQuotes([
        { observedAt: new Date("2026-10-09T19:59:59Z"), priceUsd: 120 },
        { observedAt: new Date("2026-10-09T19:59:59Z"), priceUsd: 120 }, // the same Friday close, synced again on Saturday
        { observedAt: new Date("2026-10-12T15:00:00Z"), priceUsd: 121 },
        { observedAt: new Date("2026-10-12T19:59:00Z"), priceUsd: 122 },
      ]),
    ).toEqual([
      { day: "2026-10-09", priceUsd: 120 },
      { day: "2026-10-12", priceUsd: 122 },
    ]);
  });
});
