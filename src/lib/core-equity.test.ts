import { describe, expect, it } from "vitest";
import { summarizeEquity, type EquityPoint } from "./core-equity";

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
